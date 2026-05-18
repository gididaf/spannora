import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

export interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description: string }>;
  }>;
}

export type AskUserAnswer =
  | { answers: Record<string, string> }
  | { denied: true; message: string };

export interface ChatParams {
  prompt: string;
  cwd: string;
  /** SDK session id from a prior turn — passed as `options.resume`. */
  resumeSessionId?: string | null;
  /**
   * Invoked when the model calls AskUserQuestion. The host resolves with the
   * collected answers (keyed by question text) or denies with a message. The
   * SDK pauses tool execution until this returns.
   */
  requestUserAnswer?: (toolUseId: string, input: AskUserQuestionInput) => Promise<AskUserAnswer>;
}

export interface ChatStreamHandlers {
  onMessage: (message: unknown) => void;
  onError: (error: unknown) => void;
  onEnd: () => void;
}

export interface ChatHandle {
  cancel: () => void;
}

export function startChat(params: ChatParams, handlers: ChatStreamHandlers): ChatHandle {
  let q: Query | undefined;
  let cancelled = false;

  (async () => {
    try {
      q = query({
        prompt: params.prompt,
        options: {
          cwd: params.cwd,
          // The `[1m]` suffix routes to the 1M context variant — the SDK's
          // status-line code triggers off this substring (cli.js R$). Override
          // with SPANNORA_MODEL if you want a different model.
          model: process.env.SPANNORA_MODEL || "claude-opus-4-7[1m]",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: { ...process.env, IS_SANDBOX: "1" },
          // Use Claude Code's default system prompt so the model receives the
          // `<env>` block (working directory, OS, date, model). Without this,
          // the SDK uses a minimal prompt and the model hallucinates paths
          // because it doesn't know the cwd.
          systemPrompt: { type: "preset", preset: "claude_code" },
          // Under bypassPermissions, only tools that flag
          // `requiresUserInteraction` (currently AskUserQuestion and
          // ExitPlanMode) actually reach canUseTool — everything else is
          // auto-approved by the mode shortcut in the SDK. Route the
          // interactive ones to the host; pass-through anything else.
          canUseTool: async (toolName, input, opts) => {
            if (toolName !== "AskUserQuestion" || !params.requestUserAnswer) {
              return { behavior: "allow", updatedInput: input };
            }
            const result = await params.requestUserAnswer(
              opts.toolUseID,
              input as unknown as AskUserQuestionInput,
            );
            if ("denied" in result) {
              return { behavior: "deny", message: result.message };
            }
            return {
              behavior: "allow",
              updatedInput: {
                questions: (input as { questions: unknown }).questions,
                answers: result.answers,
              },
            };
          },
          ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
        },
      });

      for await (const message of q) {
        if (cancelled) break;
        handlers.onMessage(message);
      }
    } catch (err) {
      if (!cancelled) handlers.onError(err);
    } finally {
      handlers.onEnd();
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      // Query extends AsyncGenerator — return() is the protocol-defined
      // way to terminate iteration; the SDK cleans up the child process.
      q?.return(undefined).catch(() => { /* ignore */ });
    },
  };
}
