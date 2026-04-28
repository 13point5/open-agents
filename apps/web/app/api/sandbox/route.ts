import { checkBotId } from "botid/server";
import { connectSandbox, type SandboxState } from "@open-agents/sandbox";
import {
  requireAuthenticatedUser,
  requireOwnedSession,
  type SessionRecord,
} from "@/app/api/sessions/_lib/session-context";
import { botIdConfig } from "@/lib/botid";
import { getGitHubUserProfile, getUserGitHubToken } from "@/lib/github/token";
import { updateSession } from "@/lib/db/sessions";
import { parseGitHubUrl } from "@/lib/github/client";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import { installGlobalSkills } from "@/lib/skills/global-skill-installer";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getSessionSandboxName,
  hasResumableSandboxState,
} from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";
// import { buildDevelopmentDotenvFromVercelProject } from "@/lib/vercel/projects";
// import { getUserVercelToken } from "@/lib/vercel/token";

interface CreateSandboxRequest {
  repoUrl?: string;
  branch?: string;
  isNewBranch?: boolean;
  sessionId?: string;
  sandboxType?: "vercel";
}

type SandboxConnectConfig = Parameters<typeof connectSandbox>[0];
type SandboxCreationErrorResponse = {
  error: string;
  reason?: string;
  actionUrl?: string;
  actionLabel?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function getSandboxCreationErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (
    (normalized.includes("timeout") || normalized.includes("duration")) &&
    (normalized.includes("45") ||
      normalized.includes("hobby") ||
      normalized.includes("plan"))
  ) {
    return "Sandbox creation failed because the configured timeout exceeds your Vercel Sandbox plan limit. On Hobby, the timeout must be 45 minutes or less.";
  }

  if (
    normalized.includes("status code 402") ||
    normalized.includes("payment required") ||
    normalized.includes("sandbox creation is paused") ||
    ((normalized.includes("usage") ||
      normalized.includes("quota") ||
      normalized.includes("limit") ||
      normalized.includes("billing")) &&
      normalized.includes("sandbox"))
  ) {
    return "Sandbox creation failed because your Vercel Sandbox usage is paused or your current Vercel plan does not allow more Sandbox usage. Check Vercel Sandbox usage and limits, or upgrade to Pro.";
  }

  if (
    normalized.includes("snapshot") &&
    (normalized.includes("404") ||
      normalized.includes("403") ||
      normalized.includes("not found") ||
      normalized.includes("forbidden") ||
      normalized.includes("unauthorized"))
  ) {
    return "Sandbox creation failed because the configured base snapshot is unavailable for this Vercel account. Set VERCEL_SANDBOX_BASE_SNAPSHOT_ID to a snapshot you own.";
  }

  return message || "Failed to create sandbox. Please try again.";
}

function getSandboxCreationErrorResponse(error: unknown): {
  status: number;
  body: SandboxCreationErrorResponse;
} {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("status code 402") ||
    normalized.includes("payment required") ||
    normalized.includes("sandbox creation is paused")
  ) {
    return {
      status: 402,
      body: {
        error: getSandboxCreationErrorMessage(error),
        reason: "vercel_sandbox_usage_paused",
        actionUrl: "https://vercel.com/docs/vercel-sandbox/pricing",
        actionLabel: "View Vercel Sandbox limits",
      },
    };
  }

  return {
    status: 500,
    body: { error: getSandboxCreationErrorMessage(error) },
  };
}

function isSandboxNotFoundError(error: unknown): boolean {
  const normalized = getErrorMessage(error).toLowerCase();

  return (
    normalized.includes("status code 404") || normalized.includes("not found")
  );
}

function isSandboxBadRequestError(error: unknown): boolean {
  return getErrorMessage(error).toLowerCase().includes("status code 400");
}

function buildSandboxConnectConfig(params: {
  sandboxName?: string;
  source?: {
    repo: string;
    branch?: string;
    newBranch?: string;
  };
  githubToken?: string;
  gitUser: {
    name: string;
    email: string;
  };
  baseSnapshotId?: string;
  persistent?: boolean;
}): SandboxConnectConfig {
  const persistent = params.persistent ?? !!params.sandboxName;

  return {
    state: {
      type: "vercel",
      ...(params.sandboxName ? { sandboxName: params.sandboxName } : {}),
      ...(params.source ? { source: params.source } : {}),
    },
    options: {
      githubToken: params.githubToken,
      gitUser: params.gitUser,
      timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      ports: DEFAULT_SANDBOX_PORTS,
      ...(params.baseSnapshotId
        ? { baseSnapshotId: params.baseSnapshotId }
        : {}),
      persistent,
      resume: persistent && !!params.sandboxName,
      createIfMissing: persistent && !!params.sandboxName,
    },
  };
}

// async function syncVercelProjectEnvVarsToSandbox(params: {
//   userId: string;
//   sessionRecord: SessionRecord;
//   sandbox: Awaited<ReturnType<typeof connectSandbox>>;
// }): Promise<void> {
//   if (!params.sessionRecord.vercelProjectId) {
//     return;
//   }
//
//   const token = await getUserVercelToken(params.userId);
//   if (!token) {
//     return;
//   }
//
//   const dotenvContent = await buildDevelopmentDotenvFromVercelProject({
//     token,
//     projectIdOrName: params.sessionRecord.vercelProjectId,
//     teamId: params.sessionRecord.vercelTeamId,
//   });
//   if (!dotenvContent) {
//     return;
//   }
//
//   await params.sandbox.writeFile(
//     `${params.sandbox.workingDirectory}/.env.local`,
//     dotenvContent,
//     "utf-8",
//   );
// }

async function installSessionGlobalSkills(params: {
  sessionRecord: SessionRecord;
  sandbox: Awaited<ReturnType<typeof connectSandbox>>;
}): Promise<void> {
  const globalSkillRefs = params.sessionRecord.globalSkillRefs ?? [];
  if (globalSkillRefs.length === 0) {
    return;
  }

  await installGlobalSkills({
    sandbox: params.sandbox,
    globalSkillRefs,
  });
}

export async function POST(req: Request) {
  let body: CreateSandboxRequest;
  try {
    body = (await req.json()) as CreateSandboxRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.sandboxType && body.sandboxType !== "vercel") {
    return Response.json({ error: "Invalid sandbox type" }, { status: 400 });
  }

  const { repoUrl, branch = "main", isNewBranch = false, sessionId } = body;

  // Get session for auth
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const botVerification = await checkBotId(botIdConfig);
  if (botVerification.isBot) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const githubToken = await getUserGitHubToken(session.user.id);

  if (repoUrl) {
    const parsedRepo = parseGitHubUrl(repoUrl);
    if (!parsedRepo) {
      return Response.json(
        { error: "Invalid GitHub repository URL" },
        { status: 400 },
      );
    }

    if (!githubToken) {
      return Response.json(
        { error: "Connect GitHub to access repositories" },
        { status: 403 },
      );
    }
  }

  // Validate session ownership
  let sessionRecord: SessionRecord | undefined;
  if (sessionId) {
    const sessionContext = await requireOwnedSession({
      userId: session.user.id,
      sessionId,
    });
    if (!sessionContext.ok) {
      return sessionContext.response;
    }

    sessionRecord = sessionContext.sessionRecord;
  }

  const sandboxName = sessionId ? getSessionSandboxName(sessionId) : undefined;
  const ghProfile = await getGitHubUserProfile(session.user.id);
  const githubNoreplyEmail =
    ghProfile?.externalUserId && ghProfile.username
      ? `${ghProfile.externalUserId}+${ghProfile.username}@users.noreply.github.com`
      : undefined;

  const gitUser = {
    name: session.user.name ?? ghProfile?.username ?? session.user.username,
    email:
      githubNoreplyEmail ??
      session.user.email ??
      `${session.user.username}@users.noreply.github.com`,
  };

  // ============================================
  // CREATE OR RESUME: Create a named persistent sandbox for this session.
  // ============================================
  const startTime = Date.now();

  const source = repoUrl
    ? {
        repo: repoUrl,
        branch: isNewBranch ? undefined : branch,
        newBranch: isNewBranch ? branch : undefined,
      }
    : undefined;

  let sandbox: Awaited<ReturnType<typeof connectSandbox>>;
  const initialConnectConfig = buildSandboxConnectConfig({
    sandboxName,
    source,
    githubToken: githubToken ?? undefined,
    gitUser,
    baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  });
  try {
    sandbox = await connectSandbox(initialConnectConfig);
  } catch (error) {
    const retryWithoutPersistence = async () =>
      connectSandbox(
        buildSandboxConnectConfig({
          source,
          githubToken: githubToken ?? undefined,
          gitUser,
          persistent: false,
        }),
      );

    if (DEFAULT_SANDBOX_BASE_SNAPSHOT_ID && isSandboxNotFoundError(error)) {
      console.warn(
        "Base snapshot unavailable for this Vercel account; retrying sandbox creation without a base snapshot.",
      );

      try {
        sandbox = await connectSandbox(
          buildSandboxConnectConfig({
            sandboxName,
            source,
            githubToken: githubToken ?? undefined,
            gitUser,
          }),
        );
      } catch (retryError) {
        if (sandboxName && isSandboxBadRequestError(retryError)) {
          console.warn(
            "Persistent sandbox creation was rejected by this Vercel account; retrying with an ephemeral sandbox.",
          );

          try {
            sandbox = await retryWithoutPersistence();
          } catch (fallbackError) {
            console.error("Failed to create sandbox:", fallbackError);
            const errorResponse =
              getSandboxCreationErrorResponse(fallbackError);
            return Response.json(errorResponse.body, {
              status: errorResponse.status,
            });
          }
        } else {
          console.error("Failed to create sandbox:", retryError);
          const errorResponse = getSandboxCreationErrorResponse(retryError);
          return Response.json(errorResponse.body, {
            status: errorResponse.status,
          });
        }
      }
    } else if (sandboxName && isSandboxBadRequestError(error)) {
      console.warn(
        "Persistent sandbox creation was rejected by this Vercel account; retrying with an ephemeral sandbox.",
      );

      try {
        sandbox = await retryWithoutPersistence();
      } catch (fallbackError) {
        console.error("Failed to create sandbox:", fallbackError);
        const errorResponse = getSandboxCreationErrorResponse(fallbackError);
        return Response.json(errorResponse.body, {
          status: errorResponse.status,
        });
      }
    } else {
      console.error("Failed to create sandbox:", error);
      const errorResponse = getSandboxCreationErrorResponse(error);
      return Response.json(errorResponse.body, {
        status: errorResponse.status,
      });
    }
  }

  if (sessionId && sandbox.getState) {
    const nextState = sandbox.getState() as SandboxState;
    await updateSession(sessionId, {
      sandboxState: nextState,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(
        sessionRecord?.lifecycleVersion,
      ),
      ...buildActiveLifecycleUpdate(nextState),
    });

    if (sessionRecord) {
      // TODO: Re-enable this once we have a solid exfiltration defense strategy.
      // try {
      //   await syncVercelProjectEnvVarsToSandbox({
      //     userId: session.user.id,
      //     sessionRecord,
      //     sandbox,
      //   });
      // } catch (error) {
      //   console.error(
      //     `Failed to sync Vercel env vars for session ${sessionRecord.id}:`,
      //     error,
      //   );
      // }

      try {
        await installSessionGlobalSkills({
          sessionRecord,
          sandbox,
        });
      } catch (error) {
        console.error(
          `Failed to install global skills for session ${sessionRecord.id}:`,
          error,
        );
      }
    }

    kickSandboxLifecycleWorkflow({
      sessionId,
      reason: "sandbox-created",
    });
  }

  const readyMs = Date.now() - startTime;

  return Response.json({
    createdAt: Date.now(),
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    currentBranch: repoUrl ? branch : undefined,
    mode: "vercel",
    timing: { readyMs },
  });
}

export async function DELETE(req: Request) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("sessionId" in body) ||
    typeof (body as Record<string, unknown>).sessionId !== "string"
  ) {
    return Response.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const { sessionId } = body as { sessionId: string };

  const sessionContext = await requireOwnedSession({
    userId: authResult.userId,
    sessionId,
  });
  if (!sessionContext.ok) {
    return sessionContext.response;
  }

  const { sessionRecord } = sessionContext;

  // If there's no sandbox to stop, return success (idempotent)
  if (!canOperateOnSandbox(sessionRecord.sandboxState)) {
    return Response.json({ success: true, alreadyStopped: true });
  }

  // Connect and stop using unified API
  const sandbox = await connectSandbox(sessionRecord.sandboxState);
  await sandbox.stop();

  const clearedState = clearSandboxState(sessionRecord.sandboxState);
  await updateSession(sessionId, {
    sandboxState: clearedState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleState:
      hasResumableSandboxState(clearedState) || !!sessionRecord.snapshotUrl
        ? "hibernated"
        : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return Response.json({ success: true });
}
