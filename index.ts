import type {
	ExtensionAPI,
	ExtensionContext,
	PlanReviewRequestedEvent,
} from "@oh-my-pi/pi-coding-agent";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";

// Shared Plannotator event API (documented in its README): no internal imports.
const REQUEST_CHANNEL = "plannotator:request";
const RESULT_CHANNEL = "plannotator:review-result";
const START_TIMEOUT_MS = 5_000;
const APPROVAL_NOTES_TYPE = "plannotator-approval-notes";

interface PendingBrowserReview {
	nativeReviewId: string;
	sessionId: string;
	planFilePath: string;
	planContent: string;
	ctx: ExtensionContext;
	timer: Timer | undefined;
	browserReviewId: string | undefined;
	/** The first well-formed browser result was taken; later ones are replays. */
	resultConsumed: boolean;
}

interface SharedReviewResult {
	reviewId?: unknown;
	approved?: unknown;
	feedback?: unknown;
}

const RETRY_HINT = "Use the native dialog, or press Esc and resubmit with /plan-review.";

export default function (pi: ExtensionAPI): void {
	let current: PendingBrowserReview | undefined;
	let supportWarned = false;

	const invalidate = (): void => {
		if (current?.timer !== undefined) current.ctx.clearTimer(current.timer);
		current = undefined;
	};

	const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" = "warning"): void => {
		try {
			ctx.ui.notify(message, type);
		} catch (error) {
			pi.logger.warn("plannotator bridge notification failed", { error: String(error) });
		}
	};

	const supportsNativeReview = (ctx: ExtensionContext): boolean => {
		if (typeof ctx.resolvePlanReview === "function" && typeof ctx.getPendingPlanReview === "function") {
			return true;
		}
		if (!supportWarned) {
			supportWarned = true;
			notify(
				ctx,
				"This omp version does not support native plan review bridging (missing getPendingPlanReview / resolvePlanReview). Use the native plan review dialog.",
			);
		}
		return false;
	};

	const failStart = (record: PendingBrowserReview, detail?: string): void => {
		if (current !== record) return;
		if (record.timer !== undefined) record.ctx.clearTimer(record.timer);
		current = undefined;
		notify(
			record.ctx,
			`Plannotator failed to start. Use the native plan review dialog.${detail ? ` (${detail})` : ""}`,
		);
	};

	const handleReviewResult = (data: unknown): void => {
		const record = current;
		if (!record || record.resultConsumed || record.browserReviewId === undefined) return;
		if (typeof data !== "object" || data === null) return;
		const result = data as SharedReviewResult;
		if (typeof result.reviewId !== "string" || result.reviewId !== record.browserReviewId) return;
		if (typeof result.approved !== "boolean") return;
		if (result.feedback !== undefined && typeof result.feedback !== "string") return;

		// Consume synchronously: a replayed/concurrent result must not act twice.
		record.resultConsumed = true;
		if (record.timer !== undefined) {
			record.ctx.clearTimer(record.timer);
			record.timer = undefined;
		}
		void applyReviewResult(record, result.approved, result.feedback);
	};

	const applyReviewResult = async (
		record: PendingBrowserReview,
		approved: boolean,
		feedback: string | undefined,
	): Promise<void> => {
		const ctx = record.ctx;
		try {
			if (!approved) {
				if (feedback !== undefined && feedback.trim().length > 0) {
					const accepted = ctx.resolvePlanReview(record.nativeReviewId, "refine", { feedback });
					if (!accepted) {
						notify(ctx, `The native plan review is no longer pending; feedback was not submitted. ${RETRY_HINT}`);
					}
				}
				// Rejected without feedback: leave the native review untouched.
				return;
			}

			if (ctx.localProtocolOptions === undefined) {
				notify(
					ctx,
					`Missing local:// context (localProtocolOptions); the plan was not automatically approved. ${RETRY_HINT}`,
				);
				return;
			}

			let content: string | null;
			try {
				content = await readPlanFile(record.planFilePath, {
					cwd: ctx.cwd,
					localProtocolOptions: ctx.localProtocolOptions,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				notify(ctx, `Failed to read the plan (${detail}); the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}

			if (content === null) {
				notify(ctx, `The plan file does not exist; the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}
			if (content !== record.planContent) {
				notify(ctx, `The plan file has changed; the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}

			// Re-check after the read; no await between these checks and the call.
			// shortcut: native overlay edits are not exposed by the hook API; require core support before allowing concurrent editors.
			if (current !== record) {
				notify(ctx, `The native plan review is no longer pending; the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}
			if (ctx.sessionManager.getSessionId() !== record.sessionId) {
				notify(ctx, `The session has changed; the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}
			const pending = ctx.getPendingPlanReview();
			if (
				pending === undefined ||
				pending.reviewId !== record.nativeReviewId ||
				pending.sessionId !== record.sessionId
			) {
				notify(ctx, `The native plan review is no longer pending; the plan was not automatically approved. ${RETRY_HINT}`);
				return;
			}

			if (!pending.tiers?.some(tier => tier.role === "default")) {
				notify(
					ctx,
					`The default execution model is not selectable in this review; the plan was not automatically approved. ${RETRY_HINT}`,
				);
				return;
			}

			const accepted = ctx.resolvePlanReview(record.nativeReviewId, "compact", { role: "default" });
			if (!accepted) {
				notify(
					ctx,
					`The native plan review is no longer pending or the default execution model is unavailable; the plan was not automatically approved. ${RETRY_HINT}`,
				);
				return;
			}
			if (feedback !== undefined && feedback.trim().length > 0) {
				try {
					pi.sendMessage(
						{ customType: APPROVAL_NOTES_TYPE, content: feedback, display: true },
						{ deliverAs: "nextTurn", triggerTurn: false },
					);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					notify(ctx, `The plan was approved, but approval notes could not be sent (${detail}).`);
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			notify(ctx, `Plan approval bridging failed (${detail}). ${RETRY_HINT}`);
		}
	};

	pi.on("plan_review_requested", (event: PlanReviewRequestedEvent, ctx) => {
		if (ctx.agent.kind !== "main" || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!supportsNativeReview(ctx)) return;
		if (!event.options.some(option => option.id === "compact" && !option.disabled)) {
			notify(ctx, `This review does not offer "Approve and compact context". Use the native plan review dialog.`);
			return;
		}
		if (current?.nativeReviewId === event.reviewId) return;

		invalidate();
		const record: PendingBrowserReview = {
			nativeReviewId: event.reviewId,
			sessionId: event.sessionId,
			planFilePath: event.planFilePath,
			planContent: event.planContent,
			ctx,
			timer: undefined,
			browserReviewId: undefined,
			resultConsumed: false,
		};
		current = record;

		const respond = (response: unknown): void => {
			// Timed out, replaced, switched away, or already answered.
			if (current !== record || record.browserReviewId !== undefined) return;
			const shaped = response as {
				status?: unknown;
				result?: { status?: unknown; reviewId?: unknown };
				error?: unknown;
			};
			if (
				shaped?.status === "handled" &&
				shaped.result?.status === "pending" &&
				typeof shaped.result.reviewId === "string" &&
				shaped.result.reviewId.length > 0
			) {
				if (record.timer !== undefined) {
					ctx.clearTimer(record.timer);
					record.timer = undefined;
				}
				record.browserReviewId = shaped.result.reviewId;
				return;
			}
			const detail =
				shaped?.status === "unavailable" || shaped?.status === "error"
					? typeof shaped.error === "string" && shaped.error.length > 0
						? shaped.error
						: shaped.status
					: "invalid response";
			failStart(record, detail);
		};

		// Arm the startup timer before emitting: a synchronous respond must be able
		// to cancel it.
		record.timer = ctx.setTimeout(() => {
			if (current !== record) return;
			current = undefined;
			notify(ctx, "Plannotator failed to start. Use the native plan review dialog. (timeout)");
		}, START_TIMEOUT_MS);

		try {
			pi.events.emit(REQUEST_CHANNEL, {
				requestId: crypto.randomUUID(),
				action: "plan-review",
				payload: { planContent: event.planContent, planFilePath: event.planFilePath },
				respond,
			});
		} catch (error) {
			failStart(record, error instanceof Error ? error.message : String(error));
		}
	});

	pi.on("plan_review_resolved", event => {
		if (current?.nativeReviewId === event.reviewId) invalidate();
	});

	const onSessionTransition = (_event: unknown, ctx: ExtensionContext): void => {
		if (ctx.agent.kind !== "main") return;
		invalidate();
	};

	pi.on("session_start", (event, ctx) => {
		onSessionTransition(event, ctx);
		if (ctx.agent.kind === "main") supportsNativeReview(ctx);
	});
	pi.on("session_switch", onSessionTransition);
	pi.on("session_tree", onSessionTransition);
	pi.on("session_branch", onSessionTransition);

	const unsubscribeResult = pi.events.on(RESULT_CHANNEL, handleReviewResult);
	pi.on("session_shutdown", () => {
		invalidate();
		unsubscribeResult();
	});
}
