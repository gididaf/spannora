import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

export interface ChatParams {
  prompt: string;
  cwd: string;
  /** SDK session id from a prior turn — passed as `options.resume`. */
  resumeSessionId?: string | null;
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
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          env: { ...process.env, IS_SANDBOX: "1" },
          // Use Claude Code's default system prompt so the model receives the
          // `<env>` block (working directory, OS, date, model). Without this,
          // the SDK uses a minimal prompt and the model hallucinates paths
          // because it doesn't know the cwd.
          systemPrompt: { type: "preset", preset: "claude_code" },
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
