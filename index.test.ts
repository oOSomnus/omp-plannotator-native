import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, PlanReviewRequestedEvent, PlanReviewTier } from "@oh-my-pi/pi-coding-agent";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import extension from "./index";

interface FakeTimer {
	cleared: boolean;
	fire(): void;
}

interface FakeContext {
	mode: "tui";
	hasUI: boolean;
	cwd: string;
	agent: { kind: "main" | "sub"; id: string };
	localProtocolOptions: { getSessionId: () => string } | undefined;
	sessionManager: { getSessionId: () => string };
	ui: { notify: (message: string, type?: string) => void };
	setTimeout: (callback: () => void) => FakeTimer;
	clearTimer: (timer: FakeTimer) => void;
	getPendingPlanReview: () =>
		| Pick<PlanReviewRequestedEvent, "reviewId" | "sessionId" | "tiers">
		| undefined;
	resolvePlanReview: (
		reviewId: string,
		choice: string,
		input?: { feedback?: string; role?: string },
	) => boolean;
}

interface SharedRequest {
	action?: unknown;
	respond: (response: unknown) => void;
}

interface FakeReviewOption {
	id: string;
	label: string;
	disabled: boolean;
}

type Handler = (event: unknown, ctx: FakeContext) => unknown;

const COMPACT_OPTIONS: FakeReviewOption[] = [
	{ id: "execute", label: "Approve and execute", disabled: false },
	{ id: "compact", label: "Approve and compact context", disabled: false },
	{ id: "refine", label: "Refine plan", disabled: false },
];

const REVIEW_TIERS: PlanReviewTier[] = [
	{ role: "slow", provider: "test", model: "slow-model" },
	{ role: "default", provider: "test", model: "default-model" },
];

/** Reviews where the default execution tier cannot be selected. */
const NO_DEFAULT_TIERS: Pick<PlanReviewRequestedEvent, "tiers">[] = [
	{},
	{ tiers: [] },
	{ tiers: [REVIEW_TIERS[0]!] },
];

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
	tempDirs.length = 0;
});

async function makePlan(content = "PLAN") {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plannotator-bridge-"));
	tempDirs.push(dir);
	const file = path.join(dir, "plan.md");
	await fs.writeFile(file, content);
	return { dir, file };
}

function createHarness(cwd: string) {
	const bus = new EventBus();
	const handlers = new Map<string, Handler[]>();
	const notifications: { message: string; type?: string }[] = [];
	const messages: { message: unknown; options: unknown }[] = [];
	const timers: FakeTimer[] = [];
	const resolutions: { reviewId: string; choice: string; input?: { feedback?: string; role?: string } }[] = [];
	const session = { id: "session-1" };
	let pending: Pick<PlanReviewRequestedEvent, "reviewId" | "sessionId" | "tiers"> | undefined;
	let resolveResult = true;

	const ctx: FakeContext = {
		mode: "tui",
		hasUI: true,
		cwd,
		agent: { kind: "main", id: "Main" },
		localProtocolOptions: { getSessionId: () => session.id },
		sessionManager: { getSessionId: () => session.id },
		ui: {
			notify: (message, type) => {
				notifications.push({ message, type });
			},
		},
		setTimeout: callback => {
			const timer: FakeTimer = {
				cleared: false,
				fire() {
					if (this.cleared) return;
					this.cleared = true;
					callback();
				},
			};
			timers.push(timer);
			return timer;
		},
		clearTimer: timer => {
			timer.cleared = true;
		},
		getPendingPlanReview: () => pending,
		resolvePlanReview: (reviewId, choice, input) => {
			resolutions.push({ reviewId, choice, input });
			return resolveResult;
		},
	};

	const api = {
		events: bus,
		on: (type: string, handler: Handler) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
		},
		sendMessage: (message: unknown, options: unknown) => {
			messages.push({ message, options });
		},
	};

	// Test double implements only the ExtensionAPI surface the bridge uses.
	extension(api as unknown as ExtensionAPI);

	const fire = (type: string, event: unknown, context: FakeContext = ctx): void => {
		for (const handler of handlers.get(type) ?? []) handler(event, context);
	};

	const request = (
		nativeReviewId: string,
		file: string,
		content: string,
		options: FakeReviewOption[] = COMPACT_OPTIONS,
	): void => {
		fire("plan_review_requested", {
			type: "plan_review_requested",
			reviewId: nativeReviewId,
			sessionId: session.id,
			title: "Plan",
			planFilePath: file,
			planContent: content,
			options,
			...(pending?.tiers === undefined ? {} : { tiers: pending.tiers }),
		});
	};

	const result = (reviewId: string, approved: boolean, feedback?: string): void => {
		bus.emit("plannotator:review-result", {
			reviewId,
			approved,
			...(feedback === undefined ? {} : { feedback }),
		});
	};

	return {
		bus,
		ctx,
		notifications,
		messages,
		timers,
		resolutions,
		session,
		fire,
		request,
		result,
		setPending: (
			reviewId: string | undefined,
			meta: Pick<PlanReviewRequestedEvent, "tiers"> = { tiers: REVIEW_TIERS },
		) => {
			pending = reviewId === undefined ? undefined : { reviewId, sessionId: session.id, ...meta };
		},
		setResolveResult: (value: boolean) => {
			resolveResult = value;
		},
		setProtocolOptions: (value: FakeContext["localProtocolOptions"]) => {
			ctx.localProtocolOptions = value;
		},
	};
}

type Harness = ReturnType<typeof createHarness>;

function answerWith(harness: Harness, respond: (request: SharedRequest) => unknown): void {
	harness.bus.on("plannotator:request", (data: unknown) => {
		const request = data as SharedRequest;
		if (request.action !== "plan-review") return;
		request.respond(respond(request));
	});
}

/** Yields to the event loop; no wall-clock delay, just drains pending work. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let turn = 0; turn < 1_000; turn += 1) {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function hasWarning(harness: Harness): boolean {
	return harness.notifications.some(item => item.type === "warning");
}

describe("native plan bridge", () => {
	test("ignores non-main, non-TUI reviews and reviews without a compact option", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		let requests = 0;
		harness.bus.on("plannotator:request", () => {
			requests += 1;
		});

		harness.fire(
			"plan_review_requested",
			{
				type: "plan_review_requested",
				reviewId: "native-sub",
				sessionId: harness.session.id,
				title: "Plan",
				planFilePath: file,
				planContent: "PLAN",
				options: COMPACT_OPTIONS,
			},
			{ ...harness.ctx, agent: { kind: "sub", id: "0-Explore" } },
		);
		expect(requests).toBe(0);

		harness.request("native-no-compact", file, "PLAN", [
			{ id: "execute", label: "Approve and execute", disabled: false },
			{ id: "compact", label: "Approve and compact context", disabled: true },
		]);
		expect(requests).toBe(0);
		expect(hasWarning(harness)).toBe(true);
	});

	test("approves through the native compact choice and carries approval notes", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		harness.setPending("native-1");
		answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));

		harness.request("native-1", file, "PLAN");
		expect(harness.timers[0]?.cleared).toBe(true);
		harness.result("browser-1", true, "keep the changelog");
		await waitFor(() => harness.resolutions.length === 1, "native approval");

		expect(harness.messages).toEqual([
			{
				message: { customType: "plannotator-approval-notes", content: "keep the changelog", display: true },
				options: { deliverAs: "nextTurn", triggerTurn: false },
			},
		]);
	});

	test("consumes a replayed result once and ignores an old browser review", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		harness.setPending("native-1");
		answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));

		harness.request("native-1", file, "PLAN");
		harness.result("browser-1", true);
		harness.result("browser-1", true);
		await waitFor(() => harness.resolutions.length === 1, "single approval");
		expect(harness.resolutions).toHaveLength(1);

		harness.setPending("native-2");
		harness.request("native-2", file, "PLAN");
		harness.result("browser-1", true);
		expect(harness.resolutions).toHaveLength(1);
	});

	test("ignores results after a session switch", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		harness.setPending("native-1");
		answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));

		harness.request("native-1", file, "PLAN");
		harness.fire("session_switch", { type: "session_switch", reason: "new", previousSessionFile: undefined });
		harness.result("browser-1", true);
		expect(harness.resolutions).toEqual([]);
	});

	test("does not approve when the native review closes or is replaced while the plan is read", async () => {
		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", true);
			harness.fire("plan_review_resolved", {
				type: "plan_review_resolved",
				reviewId: "native-1",
				sessionId: harness.session.id,
				choice: "refine",
				by: "local",
			});
			await waitFor(() => hasWarning(harness), "expired review warning");
			expect(harness.resolutions).toEqual([]);
		}

		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", true);
			harness.setPending("native-2");
			harness.request("native-2", file, "PLAN");
			await waitFor(() => hasWarning(harness), "stale read warning");
			expect(harness.resolutions).toEqual([]);
		}
	});

	test("refuses approval when the on-disk plan changed, is missing, or cannot be read", async () => {
		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");
			await fs.writeFile(file, "CHANGED");

			harness.result("browser-1", true);
			await waitFor(() => hasWarning(harness), "content mismatch warning");
			expect(harness.resolutions).toEqual([]);
		}

		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");
			await fs.unlink(file);

			harness.result("browser-1", true);
			await waitFor(() => hasWarning(harness), "missing plan warning");
			expect(harness.resolutions).toEqual([]);
		}

		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", path.join(file, "nested.md"), "PLAN");

			harness.result("browser-1", true);
			await waitFor(() => hasWarning(harness), "read failure warning");
			expect(harness.resolutions).toEqual([]);
		}
	});

	test("refuses approval without local protocol options or a still-pending native review", async () => {
		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");
			harness.setProtocolOptions(undefined);

			harness.result("browser-1", true);
			expect(harness.resolutions).toEqual([]);
			expect(hasWarning(harness)).toBe(true);
		}

		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", true);
			harness.setPending("another-review");
			await waitFor(() => hasWarning(harness), "pending review warning");
			expect(harness.resolutions).toEqual([]);
		}
	});

	test("keeps native approval untouched when startup errors, times out, or returns a bad shape", async () => {
		for (const response of [
			{ status: "error", error: "boom" },
			{ status: "unavailable" },
			{ status: "handled", result: { status: "pending", reviewId: "" } },
		]) {
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => response);

			harness.request("native-1", file, "PLAN");
			harness.result("browser-1", true);
			expect(harness.resolutions).toEqual([]);
			expect(hasWarning(harness)).toBe(true);
		}

		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			let startupRequest: SharedRequest | undefined;
			harness.bus.on("plannotator:request", (data: unknown) => {
				const request = data as SharedRequest;
				if (request.action === "plan-review") startupRequest = request;
			});
			harness.request("native-1", file, "PLAN");
			expect(harness.timers).toHaveLength(1);
			harness.timers[0]!.fire();
			expect(hasWarning(harness)).toBe(true);

			startupRequest!.respond({ status: "handled", result: { status: "pending", reviewId: "browser-late" } });
			harness.result("browser-late", true);
			expect(harness.resolutions).toEqual([]);
		}
	});

	test("refines with feedback, ignores empty feedback, and never approves a rejection", async () => {
		{
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", false, "rename the output file");
			expect(harness.resolutions).toEqual([
				{ reviewId: "native-1", choice: "refine", input: { feedback: "rename the output file" } },
			]);
			expect(harness.messages).toEqual([]);
		}

		for (const feedback of ["", "   ", undefined]) {
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1");
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", false, feedback);
			expect(harness.resolutions).toEqual([]);
			expect(harness.messages).toEqual([]);
		}
	});

	test("reports a refine that native refuses", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		harness.setPending("native-1");
		answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
		harness.setResolveResult(false);

		harness.request("native-1", file, "PLAN");
		harness.result("browser-1", false, "change it");
		expect(hasWarning(harness)).toBe(true);
	});

	test("leaves native approval open when the default execution tier is unavailable", async () => {
		for (const meta of NO_DEFAULT_TIERS) {
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1", meta);
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", true, "ship it");
			await waitFor(() => hasWarning(harness), "default-unavailable warning");
			expect(harness.resolutions).toEqual([]);
			expect(harness.messages).toEqual([]);
		}
	});

	test("still refines a rejection when the default execution tier is unavailable", async () => {
		for (const meta of NO_DEFAULT_TIERS) {
			const { dir, file } = await makePlan();
			const harness = createHarness(dir);
			harness.setPending("native-1", meta);
			answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
			harness.request("native-1", file, "PLAN");

			harness.result("browser-1", false, "tighten the scope");
			expect(harness.resolutions).toEqual([
				{ reviewId: "native-1", choice: "refine", input: { feedback: "tighten the scope" } },
			]);
			expect(harness.messages).toEqual([]);
		}
	});

	test("does not retry approval when native refuses the default selection", async () => {
		const { dir, file } = await makePlan();
		const harness = createHarness(dir);
		harness.setPending("native-1");
		answerWith(harness, () => ({ status: "handled", result: { status: "pending", reviewId: "browser-1" } }));
		harness.setResolveResult(false);

		harness.request("native-1", file, "PLAN");
		harness.result("browser-1", true, "ship it");
		await waitFor(() => hasWarning(harness), "refused default selection warning");
		expect(harness.resolutions).toHaveLength(1);
		expect(harness.resolutions[0]?.input).toEqual({ role: "default" });
		expect(harness.messages).toEqual([]);
	});
});
