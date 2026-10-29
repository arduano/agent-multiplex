// GENERATED from Codex 0.162.1 JSON Schema by test/codex/generate-protocol.ts.
import { z } from "zod";
export const AbsolutePathBufSchema: z.ZodType = z.lazy(() => z.string());
export const AgentMessageDeliverySchema: z.ZodType = z.lazy(() => z.literal("async"));
export const AgentPathSchema: z.ZodType = z.lazy(() => z.string());
export const AsyncUserInputQuestionSchema: z.ZodType = z.lazy(() =>
  z
    .object({ options: z.union([z.array(z.string()), z.null()]).optional(), title: z.string() })
    .strict(),
);
export const ByteRangeSchema: z.ZodType = z.lazy(() =>
  z.object({ end: z.number().int().min(0), start: z.number().int().min(0) }).catchall(z.json()),
);
export const CodexErrorInfoSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([
      z.literal("contextWindowExceeded"),
      z.literal("sessionBudgetExceeded"),
      z.literal("usageLimitExceeded"),
      z.literal("rateLimitExceeded"),
      z.literal("flexUnavailable"),
      z.literal("serverOverloaded"),
      z.literal("cyberPolicy"),
      z.literal("misalignmentPolicyViolation"),
      z.literal("tooManyDenials"),
      z.literal("internalServerError"),
      z.literal("unauthorized"),
      z.literal("badRequest"),
      z.literal("threadRollbackFailed"),
      z.literal("sandboxError"),
      z.literal("other"),
    ]),
    z
      .object({
        httpConnectionFailed: z
          .object({ httpStatusCode: z.union([z.number().int().min(0), z.null()]).optional() })
          .catchall(z.json()),
      })
      .strict(),
    z
      .object({
        responseStreamConnectionFailed: z
          .object({ httpStatusCode: z.union([z.number().int().min(0), z.null()]).optional() })
          .catchall(z.json()),
      })
      .strict(),
    z
      .object({
        responseStreamDisconnected: z
          .object({ httpStatusCode: z.union([z.number().int().min(0), z.null()]).optional() })
          .catchall(z.json()),
      })
      .strict(),
    z
      .object({
        responseTooManyFailedAttempts: z
          .object({ httpStatusCode: z.union([z.number().int().min(0), z.null()]).optional() })
          .catchall(z.json()),
      })
      .strict(),
    z
      .object({
        activeTurnNotSteerable: z
          .object({ turnKind: NonSteerableTurnKindSchema })
          .catchall(z.json()),
      })
      .strict(),
    z.union([z.string(), z.object({}).catchall(z.json())]),
  ]),
);
export const CollabAgentStateSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      message: z.union([z.string(), z.null()]).optional(),
      status: CollabAgentStatusSchema,
    })
    .catchall(z.json()),
);
export const CollabAgentStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("pendingInit"),
    z.literal("running"),
    z.literal("interrupted"),
    z.literal("completed"),
    z.literal("errored"),
    z.literal("shutdown"),
    z.literal("notFound"),
  ]),
);
export const CollabAgentToolSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("spawnAgent"),
    z.literal("sendInput"),
    z.literal("resumeAgent"),
    z.literal("wait"),
    z.literal("closeAgent"),
    z.literal("sendMessage"),
    z.literal("followupTask"),
    z.literal("interruptAgent"),
    z.literal("listAgents"),
  ]),
);
export const CollabAgentToolCallStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("inProgress"),
    z.literal("completed"),
    z.literal("failed"),
    z.literal("interrupted"),
  ]),
);
export const CommandActionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        command: z.string(),
        name: z.string(),
        path: LegacyAppPathStringSchema,
        type: z.literal("read"),
      })
      .catchall(z.json()),
    z
      .object({
        command: z.string(),
        path: z.union([z.string(), z.null()]).optional(),
        type: z.literal("listFiles"),
      })
      .catchall(z.json()),
    z
      .object({
        command: z.string(),
        path: z.union([z.string(), z.null()]).optional(),
        query: z.union([z.string(), z.null()]).optional(),
        type: z.literal("search"),
      })
      .catchall(z.json()),
    z.object({ command: z.string(), type: z.literal("unknown") }).catchall(z.json()),
  ]),
);
export const CommandExecutionSourceSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("agent"),
    z.literal("userShell"),
    z.literal("unifiedExecStartup"),
    z.literal("unifiedExecInteraction"),
  ]),
);
export const CommandExecutionStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("inProgress"),
    z.literal("completed"),
    z.literal("failed"),
    z.literal("declined"),
  ]),
);
export const DynamicToolCallOutputContentItemSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ text: z.string(), type: z.literal("inputText") }).catchall(z.json()),
    z.object({ imageUrl: z.string(), type: z.literal("inputImage") }).catchall(z.json()),
    z.object({ audioUrl: z.string(), type: z.literal("inputAudio") }).catchall(z.json()),
  ]),
);
export const DynamicToolCallStatusSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("inProgress"), z.literal("completed"), z.literal("failed")]),
);
export const FileUpdateChangeSchema: z.ZodType = z.lazy(() =>
  z.object({ diff: z.string(), kind: PatchChangeKindSchema, path: z.string() }).catchall(z.json()),
);
export const FunctionCallOutputBodySchema: z.ZodType = z.lazy(() =>
  z.union([z.string(), z.array(FunctionCallOutputContentItemSchema)]),
);
export const FunctionCallOutputContentItemSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ text: z.string(), type: z.literal("input_text") }).catchall(z.json()),
    z.union([
      z.object({ image_url: z.string() }).catchall(z.json()),
      z.object({ file_id: z.string() }).catchall(z.json()),
    ]),
    z.object({ audio_url: z.string(), type: z.literal("input_audio") }).catchall(z.json()),
    z
      .object({ encrypted_content: z.string(), type: z.literal("encrypted_content") })
      .catchall(z.json()),
  ]),
);
export const GitInfoSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      branch: z.union([z.string(), z.null()]).optional(),
      originUrl: z.union([z.string(), z.null()]).optional(),
      sha: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const HookPromptFragmentSchema: z.ZodType = z.lazy(() =>
  z.object({ hookRunId: z.string(), text: z.string() }).catchall(z.json()),
);
export const ImageDetailSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("auto"), z.literal("low"), z.literal("high"), z.literal("original")]),
);
export const ImageGenerationFailureSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      limitId: z.string(),
      resetsAt: z.union([z.number().int(), z.null()]).optional(),
      type: z.literal("usageLimitExceeded"),
    })
    .catchall(z.json()),
);
export const LegacyAppPathStringSchema: z.ZodType = z.lazy(() => z.string());
export const McpAppDisplayModeSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("inline"), z.literal("fullscreen")]),
);
export const McpAppUiSchema: z.ZodType = z.lazy(() =>
  z
    .object({ preferredModelDisplayMode: McpAppDisplayModeSchema, resourceUri: z.string() })
    .catchall(z.json()),
);
export const McpToolCallAppContextSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      actionName: z.union([z.string(), z.null()]).optional(),
      appName: z.union([z.string(), z.null()]).optional(),
      connectorId: z.string(),
      linkId: z.union([z.string(), z.null()]).optional(),
      resourceUri: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const McpToolCallErrorSchema: z.ZodType = z.lazy(() =>
  z.object({ message: z.string() }).catchall(z.json()),
);
export const McpToolCallResultSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      _meta: z.json().optional(),
      content: z.array(z.json()),
      structuredContent: z.json().optional(),
    })
    .catchall(z.json()),
);
export const McpToolCallStatusSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("inProgress"), z.literal("completed"), z.literal("failed")]),
);
export const MemoryCitationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ entries: z.array(MemoryCitationEntrySchema), threadIds: z.array(z.string()) })
    .catchall(z.json()),
);
export const MemoryCitationEntrySchema: z.ZodType = z.lazy(() =>
  z
    .object({
      lineEnd: z.number().int().min(0),
      lineStart: z.number().int().min(0),
      note: z.string(),
      path: z.string(),
    })
    .catchall(z.json()),
);
export const MessagePhaseSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("commentary"), z.literal("partial_answer"), z.literal("final_answer")]),
);
export const MisalignmentErrorDetailsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      detailedExplanation: z.union([z.string(), z.null()]).optional(),
      errorType: z.union([z.string(), z.null()]).optional(),
      reviewTarget: z.union([z.string(), z.null()]).optional(),
      steer: z.union([MisalignmentSteerSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const MisalignmentSteerSchema: z.ZodType = z.lazy(() =>
  z.object({ message: z.string() }).catchall(z.json()),
);
export const NonSteerableTurnKindSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("review"), z.literal("compact")]),
);
export const PatchApplyStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("inProgress"),
    z.literal("completed"),
    z.literal("failed"),
    z.literal("declined"),
  ]),
);
export const PatchChangeKindSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("add") }).catchall(z.json()),
    z.object({ type: z.literal("delete") }).catchall(z.json()),
    z
      .object({ move_path: z.union([z.string(), z.null()]).optional(), type: z.literal("update") })
      .catchall(z.json()),
  ]),
);
export const ReasoningEffortSchema: z.ZodType = z.lazy(() => z.string());
export const SessionSourceSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([
      z.literal("cli"),
      z.literal("vscode"),
      z.literal("exec"),
      z.literal("appServer"),
      z.literal("unknown"),
    ]),
    z.object({ custom: z.string() }).strict(),
    z.object({ subAgent: SubAgentSourceSchema }).strict(),
  ]),
);
export const SubAgentActivityKindSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("started"),
    z.literal("interacted"),
    z.literal("interrupted"),
    z.literal("completed"),
  ]),
);
export const SubAgentSourceSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([z.literal("review"), z.literal("compact"), z.literal("memory_consolidation")]),
    z
      .object({
        thread_spawn: z
          .object({
            agent_nickname: z.union([z.string(), z.null()]).optional(),
            agent_path: z.union([AgentPathSchema, z.null()]).optional(),
            agent_role: z.union([z.string(), z.null()]).optional(),
            depth: z.number().int(),
            parent_thread_id: ThreadIdSchema,
          })
          .catchall(z.json()),
      })
      .strict(),
    z.object({ other: z.string() }).strict(),
  ]),
);
export const TextElementSchema: z.ZodType = z.lazy(() =>
  z
    .object({ byteRange: ByteRangeSchema, placeholder: z.union([z.string(), z.null()]).optional() })
    .catchall(z.json()),
);
export const ThreadSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      agentNickname: z.union([z.string(), z.null()]).optional(),
      agentRole: z.union([z.string(), z.null()]).optional(),
      canAcceptDirectInput: z.union([z.boolean(), z.null()]).optional(),
      cliVersion: z.string(),
      createdAt: z.number().int(),
      cwd: AbsolutePathBufSchema,
      daybreakEnabled: z.union([z.boolean(), z.null()]).optional(),
      environments: z.union([z.array(ThreadEnvironmentSchema), z.null()]).optional(),
      ephemeral: z.boolean(),
      extra: z.union([ThreadExtraSchema, z.null()]).optional(),
      forkedFromId: z.union([z.string(), z.null()]).optional(),
      gitInfo: z.union([GitInfoSchema, z.null()]).optional(),
      historyMode: ThreadHistoryModeSchema.optional(),
      id: z.string(),
      model: z.union([z.string(), z.null()]).optional(),
      modelProvider: z.string(),
      name: z.union([z.string(), z.null()]).optional(),
      originator: z.union([z.string(), z.null()]).optional(),
      parentThreadId: z.union([z.string(), z.null()]).optional(),
      path: z.union([z.string(), z.null()]).optional(),
      preview: z.string(),
      projectId: z.union([z.string(), z.null()]),
      reasoningEffort: z.union([ReasoningEffortSchema, z.null()]).optional(),
      recencyAt: z.union([z.number().int(), z.null()]).optional(),
      section: z.union([ThreadSectionSchema, z.null()]).optional(),
      sectionEnteredAt: z.union([z.number().int(), z.null()]).optional(),
      sessionId: z.string(),
      source: SessionSourceSchema,
      status: ThreadStatusSchema,
      threadSource: z.union([ThreadSourceSchema, z.null()]).optional(),
      turns: z.array(TurnSchema),
      updatedAt: z.number().int(),
    })
    .catchall(z.json()),
);
export const ThreadActiveFlagSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("waitingOnApproval"), z.literal("waitingOnUserInput")]),
);
export const ThreadEnvironmentSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cwd: LegacyAppPathStringSchema,
      environmentId: z.string(),
      runtimeWorkspaceRoots: z.array(LegacyAppPathStringSchema),
    })
    .catchall(z.json()),
);
export const ThreadExtraSchema: z.ZodType = z.lazy(() => z.object({}).catchall(z.json()));
export const ThreadHistoryModeSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("legacy"), z.literal("paginated")]),
);
export const ThreadIdSchema: z.ZodType = z.lazy(() => z.string());
export const ThreadItemSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        clientId: z.union([z.string(), z.null()]).optional(),
        content: z.array(UserInputSchema),
        id: z.string(),
        type: z.literal("userMessage"),
      })
      .catchall(z.json()),
    z
      .object({
        fragments: z.array(HookPromptFragmentSchema),
        id: z.string(),
        type: z.literal("hookPrompt"),
      })
      .catchall(z.json()),
    z
      .object({
        delivery: z.union([AgentMessageDeliverySchema, z.null()]).optional(),
        id: z.string(),
        memoryCitation: z.union([MemoryCitationSchema, z.null()]).optional(),
        phase: z.union([MessagePhaseSchema, z.null()]).optional(),
        questions: z.union([z.array(AsyncUserInputQuestionSchema), z.null()]).optional(),
        text: z.string(),
        type: z.literal("agentMessage"),
      })
      .catchall(z.json()),
    z
      .object({
        id: z.string(),
        name: z.string(),
        namespace: z.union([z.string(), z.null()]).optional(),
        output: FunctionCallOutputBodySchema,
        type: z.literal("functionCallOutput"),
      })
      .catchall(z.json()),
    z.object({ id: z.string(), text: z.string(), type: z.literal("plan") }).catchall(z.json()),
    z
      .object({
        content: z.array(z.string()).optional(),
        id: z.string(),
        summary: z.array(z.string()).optional(),
        type: z.literal("reasoning"),
      })
      .catchall(z.json()),
    z
      .object({
        aggregatedOutput: z.union([z.string(), z.null()]).optional(),
        command: z.string(),
        commandActions: z.array(CommandActionSchema),
        cwd: LegacyAppPathStringSchema,
        durationMs: z.union([z.number().int(), z.null()]).optional(),
        exitCode: z.union([z.number().int(), z.null()]).optional(),
        id: z.string(),
        pluginId: z.union([z.string(), z.null()]).optional(),
        processId: z.union([z.string(), z.null()]).optional(),
        scriptPath: z.union([z.string(), z.null()]).optional(),
        source: CommandExecutionSourceSchema.optional(),
        status: CommandExecutionStatusSchema,
        type: z.literal("commandExecution"),
      })
      .catchall(z.json()),
    z
      .object({
        changes: z.array(FileUpdateChangeSchema),
        id: z.string(),
        status: PatchApplyStatusSchema,
        type: z.literal("fileChange"),
      })
      .catchall(z.json()),
    z
      .object({
        appContext: z.union([McpToolCallAppContextSchema, z.null()]).optional(),
        arguments: z.json(),
        durationMs: z.union([z.number().int(), z.null()]).optional(),
        error: z.union([McpToolCallErrorSchema, z.null()]).optional(),
        id: z.string(),
        mcpAppResourceUri: z.union([z.string(), z.null()]).optional(),
        mcpAppUi: z.union([McpAppUiSchema, z.null()]).optional(),
        pluginId: z.union([z.string(), z.null()]).optional(),
        readOnlyHint: z.union([z.boolean(), z.null()]).optional(),
        result: z.union([McpToolCallResultSchema, z.null()]).optional(),
        server: z.string(),
        status: McpToolCallStatusSchema,
        tool: z.string(),
        type: z.literal("mcpToolCall"),
      })
      .catchall(z.json()),
    z
      .object({
        arguments: z.json(),
        contentItems: z
          .union([z.array(DynamicToolCallOutputContentItemSchema), z.null()])
          .optional(),
        durationMs: z.union([z.number().int(), z.null()]).optional(),
        id: z.string(),
        namespace: z.union([z.string(), z.null()]).optional(),
        status: DynamicToolCallStatusSchema,
        success: z.union([z.boolean(), z.null()]).optional(),
        tool: z.string(),
        type: z.literal("dynamicToolCall"),
      })
      .catchall(z.json()),
    z
      .object({
        agentsStates: z.object({}).catchall(CollabAgentStateSchema),
        id: z.string(),
        model: z.union([z.string(), z.null()]).optional(),
        prompt: z.union([z.string(), z.null()]).optional(),
        reasoningEffort: z.union([ReasoningEffortSchema, z.null()]).optional(),
        receiverThreadIds: z.array(z.string()),
        senderThreadId: z.string(),
        status: CollabAgentToolCallStatusSchema,
        tool: CollabAgentToolSchema,
        type: z.literal("collabAgentToolCall"),
      })
      .catchall(z.json()),
    z
      .object({
        agentPath: z.string(),
        agentThreadId: z.string(),
        id: z.string(),
        kind: SubAgentActivityKindSchema,
        model: z.union([z.string(), z.null()]).optional(),
        reasoningEffort: z.union([ReasoningEffortSchema, z.null()]).optional(),
        type: z.literal("subAgentActivity"),
      })
      .catchall(z.json()),
    z
      .object({
        action: z.union([WebSearchActionSchema, z.null()]).optional(),
        id: z.string(),
        query: z.string(),
        results: z.union([z.array(z.json()), z.null()]).optional(),
        type: z.literal("webSearch"),
      })
      .catchall(z.json()),
    z
      .object({ id: z.string(), path: LegacyAppPathStringSchema, type: z.literal("imageView") })
      .catchall(z.json()),
    z
      .object({ durationMs: z.number().int().min(0), id: z.string(), type: z.literal("sleep") })
      .catchall(z.json()),
    z
      .object({
        failure: z.union([ImageGenerationFailureSchema, z.null()]).optional(),
        id: z.string(),
        result: z.string(),
        revisedPrompt: z.union([z.string(), z.null()]).optional(),
        savedPath: z.union([AbsolutePathBufSchema, z.null()]).optional(),
        status: z.string(),
        transparentBackground: z.union([z.boolean(), z.null()]).optional(),
        type: z.literal("imageGeneration"),
      })
      .catchall(z.json()),
    z
      .object({ id: z.string(), review: z.string(), type: z.literal("enteredReviewMode") })
      .catchall(z.json()),
    z
      .object({ id: z.string(), review: z.string(), type: z.literal("exitedReviewMode") })
      .catchall(z.json()),
    z.object({ id: z.string(), type: z.literal("contextCompaction") }).catchall(z.json()),
  ]),
);
export const ThreadSectionSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      appearance: z.union([ThreadSectionAppearanceSchema, z.null()]).optional(),
      id: z.string(),
      name: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadSectionAppearanceSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      color: z.union([z.string(), z.null()]).optional(),
      icon: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadSourceSchema: z.ZodType = z.lazy(() => z.string());
export const ThreadStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("notLoaded") }).catchall(z.json()),
    z.object({ type: z.literal("idle") }).catchall(z.json()),
    z.object({ type: z.literal("systemError") }).catchall(z.json()),
    z
      .object({ activeFlags: z.array(ThreadActiveFlagSchema), type: z.literal("active") })
      .catchall(z.json()),
  ]),
);
export const TurnSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      completedAt: z.union([z.number().int(), z.null()]).optional(),
      durationMs: z.union([z.number().int(), z.null()]).optional(),
      error: z.union([TurnErrorSchema, z.null()]).optional(),
      id: z.string(),
      items: z.array(ThreadItemSchema),
      itemsView: TurnItemsViewSchema.optional(),
      rootTurnId: z.union([z.string(), z.null()]).optional(),
      startedAt: z.union([z.number().int(), z.null()]).optional(),
      status: TurnStatusSchema,
    })
    .catchall(z.json()),
);
export const TurnErrorSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      additionalDetails: z.union([z.string(), z.null()]).optional(),
      codexErrorInfo: z.union([CodexErrorInfoSchema, z.null()]).optional(),
      message: z.string(),
      misalignment: z.union([MisalignmentErrorDetailsSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const TurnItemsViewSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("notLoaded"), z.literal("summary"), z.literal("full")]),
);
export const TurnStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("completed"),
    z.literal("interrupted"),
    z.literal("failed"),
    z.literal("inProgress"),
  ]),
);
export const UserInputSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        text: z.string(),
        text_elements: z.array(TextElementSchema).optional(),
        type: z.literal("text"),
      })
      .catchall(z.json()),
    z.union([
      z.object({ url: z.string() }).catchall(z.json()),
      z.object({ fileId: z.string() }).catchall(z.json()),
    ]),
    z
      .object({
        detail: z.union([ImageDetailSchema, z.null()]).optional(),
        path: z.string(),
        type: z.literal("localImage"),
      })
      .catchall(z.json()),
    z.object({ type: z.literal("audio"), url: z.string() }).catchall(z.json()),
    z.object({ path: z.string(), type: z.literal("localAudio") }).catchall(z.json()),
    z.object({ name: z.string(), path: z.string(), type: z.literal("skill") }).catchall(z.json()),
    z.object({ name: z.string(), path: z.string(), type: z.literal("mention") }).catchall(z.json()),
  ]),
);
export const WebSearchActionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        queries: z.union([z.array(z.string()), z.null()]).optional(),
        query: z.union([z.string(), z.null()]).optional(),
        type: z.literal("search"),
      })
      .catchall(z.json()),
    z
      .object({ type: z.literal("openPage"), url: z.union([z.string(), z.null()]).optional() })
      .catchall(z.json()),
    z
      .object({
        pattern: z.union([z.string(), z.null()]).optional(),
        type: z.literal("findInPage"),
        url: z.union([z.string(), z.null()]).optional(),
      })
      .catchall(z.json()),
    z.object({ type: z.literal("other") }).catchall(z.json()),
  ]),
);
export const SortDirectionSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("asc"), z.literal("desc")]),
);
export const ThreadItemsListAnchorSchema: z.ZodType = z.lazy(() =>
  z.object({ itemId: z.string(), type: z.literal("item") }).catchall(z.json()),
);
export const ThreadItemsListCursorSchema: z.ZodType = z.lazy(() =>
  z.union([z.string(), ThreadItemsListAnchorSchema]),
);
export const ThreadItemEntrySchema: z.ZodType = z.lazy(() =>
  z
    .object({
      completedAtMs: z.union([z.number().int(), z.null()]).optional(),
      item: ThreadItemSchema,
      startedAtMs: z.union([z.number().int(), z.null()]).optional(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ApprovalsReviewerSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("user"), z.literal("auto_review"), z.literal("guardian_subagent")]),
);
export const AskForApprovalSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([z.literal("untrusted"), z.literal("on-request"), z.literal("never")]),
    z
      .object({
        granular: z
          .object({
            mcp_elicitations: z.boolean(),
            request_permissions: z.boolean().optional(),
            rules: z.boolean(),
            sandbox_approval: z.boolean(),
            skill_approval: z.boolean().optional(),
          })
          .catchall(z.json()),
      })
      .strict(),
  ]),
);
export const CollaborationModeSchema: z.ZodType = z.lazy(() =>
  z.object({ mode: ModeKindSchema, settings: SettingsSchema }).catchall(z.json()),
);
export const ModeKindSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("plan"), z.literal("default")]),
);
export const MultiAgentModeSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([z.literal("explicitRequestOnly"), z.literal("proactive")]),
    z.object({ custom: z.string() }).strict(),
  ]),
);
export const NetworkAccessSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("restricted"), z.literal("enabled")]),
);
export const PersonalitySchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("none"), z.literal("friendly"), z.literal("pragmatic")]),
);
export const ReasoningSummarySchema: z.ZodType = z.lazy(() =>
  z.union([
    z.union([z.literal("auto"), z.literal("concise"), z.literal("detailed")]),
    z.literal("none"),
  ]),
);
export const SandboxPolicySchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("dangerFullAccess") }).catchall(z.json()),
    z
      .object({ networkAccess: z.boolean().optional(), type: z.literal("readOnly") })
      .catchall(z.json()),
    z
      .object({ networkAccess: NetworkAccessSchema.optional(), type: z.literal("externalSandbox") })
      .catchall(z.json()),
    z
      .object({
        excludeSlashTmp: z.boolean().optional(),
        excludeTmpdirEnvVar: z.boolean().optional(),
        networkAccess: z.boolean().optional(),
        type: z.literal("workspaceWrite"),
        writableRoots: z.array(AbsolutePathBufSchema).optional(),
      })
      .catchall(z.json()),
  ]),
);
export const SettingsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      developer_instructions: z.union([z.string(), z.null()]).optional(),
      model: z.string(),
      reasoning_effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const AdditionalContextEntrySchema: z.ZodType = z.lazy(() =>
  z.object({ kind: AdditionalContextKindSchema, value: z.string() }).catchall(z.json()),
);
export const AdditionalContextKindSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("untrusted"), z.literal("application")]),
);
export const CyberAccessProgramSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("standard"), z.literal("daybreakBlue"), z.literal("daybreakRed")]),
);
export const TurnEnvironmentParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cwd: LegacyAppPathStringSchema,
      environmentId: z.string(),
      runtimeWorkspaceRoots: z.union([z.array(LegacyAppPathStringSchema), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const TurnToolOutputSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      name: z.string(),
      namespace: z.union([z.string(), z.null()]).optional(),
      output: FunctionCallOutputBodySchema,
    })
    .catchall(z.json()),
);
export const TurnSettingsUpdateStatusSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("applied"), z.literal("targetUnavailable")]),
);
export const InputModalitySchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("text"), z.literal("image"), z.literal("audio")]),
);
export const ModelSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      additionalSpeedTiers: z.array(z.string()).optional(),
      availabilityNux: z.union([ModelAvailabilityNuxSchema, z.null()]).optional(),
      availableAccessPrograms: z.union([ModelAccessProgramsSchema, z.null()]).optional(),
      defaultReasoningEffort: ReasoningEffortSchema,
      defaultServiceTier: z.union([z.string(), z.null()]).optional(),
      description: z.string(),
      displayName: z.string(),
      hidden: z.boolean(),
      id: z.string(),
      inputModalities: z.array(InputModalitySchema).optional(),
      isDefault: z.boolean(),
      model: z.string(),
      modelSpecialty: z.union([z.string(), z.null()]).optional(),
      multiAgentVersion: z.union([MultiAgentVersionSchema, z.null()]).optional(),
      serviceTiers: z.array(ModelServiceTierSchema).optional(),
      supportedReasoningEfforts: z.array(ReasoningEffortOptionSchema),
      supportsPersonality: z.boolean().optional(),
      upgrade: z.union([z.string(), z.null()]).optional(),
      upgradeInfo: z.union([ModelUpgradeInfoSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ModelAccessProgramsSchema: z.ZodType = z.lazy(() =>
  z.object({ cyber: z.array(CyberAccessProgramSchema) }).catchall(z.json()),
);
export const ModelAvailabilityNuxSchema: z.ZodType = z.lazy(() =>
  z.object({ message: z.string() }).catchall(z.json()),
);
export const ModelServiceTierSchema: z.ZodType = z.lazy(() =>
  z.object({ description: z.string(), id: z.string(), name: z.string() }).catchall(z.json()),
);
export const ModelUpgradeInfoSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      migrationMarkdown: z.union([z.string(), z.null()]).optional(),
      model: z.string(),
      modelLink: z.union([z.string(), z.null()]).optional(),
      retirementAt: z.union([z.number().int(), z.null()]).optional(),
      upgradeCopy: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const MultiAgentVersionSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("disabled"), z.literal("v1"), z.literal("v2")]),
);
export const ReasoningEffortOptionSchema: z.ZodType = z.lazy(() =>
  z.object({ description: z.string(), reasoningEffort: ReasoningEffortSchema }).catchall(z.json()),
);
export const QueuedSubmissionSchema: z.ZodType = z.lazy(() =>
  z
    .object({ clientUserMessageId: z.string(), id: z.string(), input: z.array(UserInputSchema) })
    .catchall(z.json()),
);
export const ThreadGoalSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      createdAt: z.number().int(),
      objective: z.string(),
      status: ThreadGoalStatusSchema,
      threadId: z.string(),
      timeUsedSeconds: z.number().int(),
      tokenBudget: z.union([z.number().int(), z.null()]).optional(),
      tokensUsed: z.number().int(),
      updatedAt: z.number().int(),
    })
    .catchall(z.json()),
);
export const ThreadGoalStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("active"),
    z.literal("paused"),
    z.literal("blocked"),
    z.literal("usageLimited"),
    z.literal("budgetLimited"),
    z.literal("complete"),
  ]),
);
export const ThreadGoalMutationOriginSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("user"), z.literal("automatic")]),
);
export const ThreadBackgroundTerminalSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      command: z.string(),
      cpuPercent: z.union([z.number(), z.null()]).optional(),
      cwd: LegacyAppPathStringSchema,
      itemId: z.string(),
      osPid: z.union([z.number().int().min(0), z.null()]).optional(),
      processId: z.string(),
      rssKb: z.union([z.number().int().min(0), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const McpServerStatusDetailSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("full"), z.literal("toolsAndAuthOnly")]),
);
export const McpAuthStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("unknown"),
    z.literal("unsupported"),
    z.literal("notLoggedIn"),
    z.literal("bearerToken"),
    z.literal("oAuth"),
  ]),
);
export const McpServerConnectionStatusSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("notStarted"),
    z.literal("starting"),
    z.literal("connected"),
    z.literal("authenticationRequired"),
    z.literal("failed"),
    z.literal("cancelled"),
    z.literal("disabled"),
  ]),
);
export const McpServerInfoSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      description: z.union([z.string(), z.null()]).optional(),
      icons: z.union([z.array(z.json()), z.null()]).optional(),
      name: z.string(),
      title: z.union([z.string(), z.null()]).optional(),
      version: z.string(),
      websiteUrl: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const McpServerStatusSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      authStatus: McpAuthStatusSchema,
      httpOrigin: z.union([z.string(), z.null()]).optional(),
      name: z.string(),
      pluginId: z.union([z.string(), z.null()]).optional(),
      resourceTemplates: z.array(ResourceTemplateSchema),
      resources: z.array(ResourceSchema),
      runtimeStatus: z.union([McpServerConnectionStatusSchema, z.null()]).optional(),
      serverCapabilities: z.json().optional(),
      serverInfo: z.union([McpServerInfoSchema, z.null()]).optional(),
      tools: z.object({}).catchall(ToolSchema),
      toolsError: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ResourceSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      _meta: z.json().optional(),
      annotations: z.json().optional(),
      description: z.union([z.string(), z.null()]).optional(),
      icons: z.union([z.array(z.json()), z.null()]).optional(),
      mimeType: z.union([z.string(), z.null()]).optional(),
      name: z.string(),
      size: z.union([z.number().int(), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      uri: z.string(),
    })
    .catchall(z.json()),
);
export const ResourceTemplateSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      annotations: z.json().optional(),
      description: z.union([z.string(), z.null()]).optional(),
      mimeType: z.union([z.string(), z.null()]).optional(),
      name: z.string(),
      title: z.union([z.string(), z.null()]).optional(),
      uriTemplate: z.string(),
    })
    .catchall(z.json()),
);
export const ToolSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      _meta: z.json().optional(),
      annotations: z.json().optional(),
      description: z.union([z.string(), z.null()]).optional(),
      icons: z.union([z.array(z.json()), z.null()]).optional(),
      inputSchema: z.json(),
      name: z.string(),
      outputSchema: z.json().optional(),
      title: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const AdditionalFileSystemPermissionsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      entries: z.union([z.array(FileSystemSandboxEntrySchema), z.null()]).optional(),
      globScanMaxDepth: z.union([z.number().int().min(1), z.null()]).optional(),
      read: z.union([z.array(LegacyAppPathStringSchema), z.null()]).optional(),
      write: z.union([z.array(LegacyAppPathStringSchema), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const AdditionalNetworkPermissionsSchema: z.ZodType = z.lazy(() =>
  z.object({ enabled: z.union([z.boolean(), z.null()]).optional() }).catchall(z.json()),
);
export const AdditionalPermissionProfileSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      fileSystem: z.union([AdditionalFileSystemPermissionsSchema, z.null()]).optional(),
      network: z.union([AdditionalNetworkPermissionsSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const CommandExecutionApprovalDecisionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("accept"),
    z.literal("acceptForSession"),
    z
      .object({
        acceptWithExecpolicyAmendment: z
          .object({ execpolicy_amendment: z.array(z.string()) })
          .catchall(z.json()),
      })
      .strict(),
    z
      .object({
        applyNetworkPolicyAmendment: z
          .object({ network_policy_amendment: NetworkPolicyAmendmentSchema })
          .catchall(z.json()),
      })
      .strict(),
    z.literal("decline"),
    z.literal("cancel"),
  ]),
);
export const CommandExecutionApprovalKindSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("command"), z.literal("writeStdin")]),
);
export const FileSystemAccessModeSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("read"), z.literal("write"), z.literal("deny")]),
);
export const FileSystemPathSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ path: LegacyAppPathStringSchema, type: z.literal("path") }).catchall(z.json()),
    z.object({ pattern: z.string(), type: z.literal("glob_pattern") }).catchall(z.json()),
    z.object({ type: z.literal("special"), value: FileSystemSpecialPathSchema }).catchall(z.json()),
  ]),
);
export const FileSystemSandboxEntrySchema: z.ZodType = z.lazy(() =>
  z.object({ access: FileSystemAccessModeSchema, path: FileSystemPathSchema }).catchall(z.json()),
);
export const FileSystemSpecialPathSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("root") }).catchall(z.json()),
    z.object({ kind: z.literal("minimal") }).catchall(z.json()),
    z
      .object({
        kind: z.literal("project_roots"),
        subpath: z.union([LegacyAppPathStringSchema, z.null()]).optional(),
      })
      .catchall(z.json()),
    z.object({ kind: z.literal("tmpdir") }).catchall(z.json()),
    z.object({ kind: z.literal("slash_tmp") }).catchall(z.json()),
    z
      .object({
        kind: z.literal("unknown"),
        path: z.string(),
        subpath: z.union([LegacyAppPathStringSchema, z.null()]).optional(),
      })
      .catchall(z.json()),
  ]),
);
export const NetworkApprovalContextSchema: z.ZodType = z.lazy(() =>
  z.object({ host: z.string(), protocol: NetworkApprovalProtocolSchema }).catchall(z.json()),
);
export const NetworkApprovalProtocolSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("http"), z.literal("https"), z.literal("socks5Tcp"), z.literal("socks5Udp")]),
);
export const NetworkPolicyAmendmentSchema: z.ZodType = z.lazy(() =>
  z.object({ action: NetworkPolicyRuleActionSchema, host: z.string() }).catchall(z.json()),
);
export const NetworkPolicyRuleActionSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("allow"), z.literal("deny")]),
);
export const FileChangeApprovalDecisionSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.literal("accept"),
    z.literal("acceptForSession"),
    z.literal("decline"),
    z.literal("cancel"),
  ]),
);
export const RequestPermissionProfileSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      fileSystem: z.union([AdditionalFileSystemPermissionsSchema, z.null()]).optional(),
      network: z.union([AdditionalNetworkPermissionsSchema, z.null()]).optional(),
    })
    .strict(),
);
export const GrantedPermissionProfileSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      fileSystem: z.union([AdditionalFileSystemPermissionsSchema, z.null()]).optional(),
      network: z.union([AdditionalNetworkPermissionsSchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const PermissionGrantScopeSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("turn"), z.literal("session")]),
);
export const ToolRequestUserInputOptionSchema: z.ZodType = z.lazy(() =>
  z.object({ description: z.string(), label: z.string() }).catchall(z.json()),
);
export const ToolRequestUserInputQuestionSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      header: z.string(),
      id: z.string(),
      isOther: z.boolean().optional(),
      isSecret: z.boolean().optional(),
      options: z.union([z.array(ToolRequestUserInputOptionSchema), z.null()]).optional(),
      question: z.string(),
    })
    .catchall(z.json()),
);
export const ToolRequestUserInputAnswerSchema: z.ZodType = z.lazy(() =>
  z.object({ answers: z.array(z.string()) }).catchall(z.json()),
);
export const McpElicitationArrayTypeSchema: z.ZodType = z.lazy(() => z.literal("array"));
export const McpElicitationBooleanSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.boolean(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationBooleanTypeSchema,
    })
    .strict(),
);
export const McpElicitationBooleanTypeSchema: z.ZodType = z.lazy(() => z.literal("boolean"));
export const McpElicitationConstOptionSchema: z.ZodType = z.lazy(() =>
  z.object({ const: z.string(), title: z.string() }).strict(),
);
export const McpElicitationEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z.union([
    McpElicitationSingleSelectEnumSchemaSchema,
    McpElicitationMultiSelectEnumSchemaSchema,
    McpElicitationLegacyTitledEnumSchemaSchema,
  ]),
);
export const McpElicitationLegacyTitledEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.string(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      enum: z.array(z.string()),
      enumNames: z.union([z.array(z.string()), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationStringTypeSchema,
    })
    .strict(),
);
export const McpElicitationMultiSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z.union([
    McpElicitationUntitledMultiSelectEnumSchemaSchema,
    McpElicitationTitledMultiSelectEnumSchemaSchema,
  ]),
);
export const McpElicitationNumberSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.number(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      maximum: z.union([z.number(), z.null()]).optional(),
      minimum: z.union([z.number(), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationNumberTypeSchema,
    })
    .strict(),
);
export const McpElicitationNumberTypeSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("number"), z.literal("integer")]),
);
export const McpElicitationObjectTypeSchema: z.ZodType = z.lazy(() => z.literal("object"));
export const McpElicitationPrimitiveSchemaSchema: z.ZodType = z.lazy(() =>
  z.union([
    McpElicitationEnumSchemaSchema,
    McpElicitationStringSchemaSchema,
    McpElicitationNumberSchemaSchema,
    McpElicitationBooleanSchemaSchema,
  ]),
);
export const McpElicitationSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      $schema: z.union([z.string(), z.null()]).optional(),
      properties: z.object({}).catchall(McpElicitationPrimitiveSchemaSchema),
      required: z.union([z.array(z.string()), z.null()]).optional(),
      type: McpElicitationObjectTypeSchema,
    })
    .strict(),
);
export const McpElicitationSingleSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z.union([
    McpElicitationUntitledSingleSelectEnumSchemaSchema,
    McpElicitationTitledSingleSelectEnumSchemaSchema,
  ]),
);
export const McpElicitationStringFormatSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("email"), z.literal("uri"), z.literal("date"), z.literal("date-time")]),
);
export const McpElicitationStringSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.string(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      format: z.union([McpElicitationStringFormatSchema, z.null()]).optional(),
      maxLength: z.union([z.number().int().min(0), z.null()]).optional(),
      minLength: z.union([z.number().int().min(0), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationStringTypeSchema,
    })
    .strict(),
);
export const McpElicitationStringTypeSchema: z.ZodType = z.lazy(() => z.literal("string"));
export const McpElicitationTitledEnumItemsSchema: z.ZodType = z.lazy(() =>
  z.object({ anyOf: z.array(McpElicitationConstOptionSchema) }).strict(),
);
export const McpElicitationTitledMultiSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.array(z.string()), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      items: McpElicitationTitledEnumItemsSchema,
      maxItems: z.union([z.number().int().min(0), z.null()]).optional(),
      minItems: z.union([z.number().int().min(0), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationArrayTypeSchema,
    })
    .strict(),
);
export const McpElicitationTitledSingleSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.string(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      oneOf: z.array(McpElicitationConstOptionSchema),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationStringTypeSchema,
    })
    .strict(),
);
export const McpElicitationUntitledEnumItemsSchema: z.ZodType = z.lazy(() =>
  z.object({ enum: z.array(z.string()), type: McpElicitationStringTypeSchema }).strict(),
);
export const McpElicitationUntitledMultiSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.array(z.string()), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      items: McpElicitationUntitledEnumItemsSchema,
      maxItems: z.union([z.number().int().min(0), z.null()]).optional(),
      minItems: z.union([z.number().int().min(0), z.null()]).optional(),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationArrayTypeSchema,
    })
    .strict(),
);
export const McpElicitationUntitledSingleSelectEnumSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      default: z.union([z.string(), z.null()]).optional(),
      description: z.union([z.string(), z.null()]).optional(),
      enum: z.array(z.string()),
      title: z.union([z.string(), z.null()]).optional(),
      type: McpElicitationStringTypeSchema,
    })
    .strict(),
);
export const McpServerElicitationActionSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("accept"), z.literal("decline"), z.literal("cancel")]),
);
export const ActivePermissionProfileSchema: z.ZodType = z.lazy(() =>
  z
    .object({ extends: z.union([z.string(), z.null()]).optional(), id: z.string() })
    .catchall(z.json()),
);
export const ThreadSettingsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      activePermissionProfile: z.union([ActivePermissionProfileSchema, z.null()]).optional(),
      approvalPolicy: AskForApprovalSchema,
      approvalsReviewer: ApprovalsReviewerSchema,
      collaborationMode: CollaborationModeSchema,
      cwd: AbsolutePathBufSchema,
      disabledPluginIds: z.array(z.string()).optional(),
      effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
      model: z.string(),
      modelProvider: z.string(),
      multiAgentMode: MultiAgentModeSchema.optional(),
      personality: z.union([PersonalitySchema, z.null()]).optional(),
      sandboxPolicy: SandboxPolicySchema,
      serviceTier: z.union([z.string(), z.null()]).optional(),
      summary: z.union([ReasoningSummarySchema, z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadTokenUsageSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      last: TokenUsageBreakdownSchema,
      modelContextWindow: z.union([z.number().int(), z.null()]).optional(),
      total: TokenUsageBreakdownSchema,
    })
    .catchall(z.json()),
);
export const TokenUsageBreakdownSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cacheWriteInputTokens: z.number().int().optional(),
      cachedInputTokens: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      reasoningOutputTokens: z.number().int(),
      totalTokens: z.number().int(),
    })
    .catchall(z.json()),
);
export const TurnPlanStepSchema: z.ZodType = z.lazy(() =>
  z.object({ status: TurnPlanStepStatusSchema, step: z.string() }).catchall(z.json()),
);
export const TurnPlanStepStatusSchema: z.ZodType = z.lazy(() =>
  z.union([z.literal("pending"), z.literal("inProgress"), z.literal("completed")]),
);
export const RequestIdSchema: z.ZodType = z.lazy(() => z.union([z.string(), z.number().int()]));
export const ThreadReadParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ includeTurns: z.boolean().optional(), threadId: z.string() }).catchall(z.json()),
);
export const ThreadReadResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ thread: ThreadSchema }).catchall(z.json()),
);
export const ThreadTurnsListParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([z.string(), z.null()]).optional(),
      itemsView: z.union([TurnItemsViewSchema, z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
      sortDirection: z.union([SortDirectionSchema, z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadTurnsListResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      backwardsCursor: z.union([z.string(), z.null()]).optional(),
      data: z.array(TurnSchema),
      nextCursor: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadItemsListParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([ThreadItemsListCursorSchema, z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
      sortDirection: z.union([SortDirectionSchema, z.null()]).optional(),
      threadId: z.string(),
      turnId: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadItemsListResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      backwardsCursor: z.union([z.string(), z.null()]).optional(),
      data: z.array(ThreadItemEntrySchema),
      nextCursor: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadSettingsUpdateParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      approvalPolicy: z.union([AskForApprovalSchema, z.null()]).optional(),
      approvalsReviewer: z.union([ApprovalsReviewerSchema, z.null()]).optional(),
      collaborationMode: z.union([CollaborationModeSchema, z.null()]).optional(),
      cwd: z.union([z.string(), z.null()]).optional(),
      disabledPluginIds: z.union([z.array(z.string()), z.null()]).optional(),
      effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
      model: z.union([z.string(), z.null()]).optional(),
      multiAgentMode: z.union([MultiAgentModeSchema, z.null()]).optional(),
      permissions: z.union([z.string(), z.null()]).optional(),
      personality: z.union([PersonalitySchema, z.null()]).optional(),
      sandboxPolicy: z.union([SandboxPolicySchema, z.null()]).optional(),
      serviceTier: z.union([z.string(), z.null()]).optional(),
      summary: z.union([ReasoningSummarySchema, z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadSettingsUpdateResponseSchema: z.ZodType = z.lazy(() =>
  z.object({}).catchall(z.json()),
);
export const TurnStartParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      additionalContext: z
        .union([z.object({}).catchall(AdditionalContextEntrySchema), z.null()])
        .optional(),
      approvalPolicy: z.union([AskForApprovalSchema, z.null()]).optional(),
      approvalsReviewer: z.union([ApprovalsReviewerSchema, z.null()]).optional(),
      clientUserMessageId: z.union([z.string(), z.null()]).optional(),
      collaborationMode: z.union([CollaborationModeSchema, z.null()]).optional(),
      cwd: z.union([z.string(), z.null()]).optional(),
      cyberAccessProgram: z.union([CyberAccessProgramSchema, z.null()]).optional(),
      disabledPluginIds: z.union([z.array(z.string()), z.null()]).optional(),
      effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
      environments: z.union([z.array(TurnEnvironmentParamsSchema), z.null()]).optional(),
      input: z.array(UserInputSchema),
      model: z.union([z.string(), z.null()]).optional(),
      multiAgentMode: z.union([MultiAgentModeSchema, z.null()]).optional(),
      outputSchema: z.json().optional(),
      parentTurnId: z.union([z.string(), z.null()]).optional(),
      permissions: z.union([z.string(), z.null()]).optional(),
      personality: z.union([PersonalitySchema, z.null()]).optional(),
      responsesapiClientMetadata: z.union([z.object({}).catchall(z.string()), z.null()]).optional(),
      rootTurnId: z.union([z.string(), z.null()]).optional(),
      runtimeWorkspaceRoots: z.union([z.array(AbsolutePathBufSchema), z.null()]).optional(),
      sandboxPolicy: z.union([SandboxPolicySchema, z.null()]).optional(),
      serviceTier: z.union([z.string(), z.null()]).optional(),
      serviceTierForTurn: z.union([z.string(), z.null()]).optional(),
      summary: z.union([ReasoningSummarySchema, z.null()]).optional(),
      threadId: z.string(),
      toolOutput: z.union([TurnToolOutputSchema, z.null()]).optional(),
      turnTrigger: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const TurnStartResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ turn: TurnSchema }).catchall(z.json()),
);
export const TurnSteerParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      additionalContext: z
        .union([z.object({}).catchall(AdditionalContextEntrySchema), z.null()])
        .optional(),
      clientUserMessageId: z.union([z.string(), z.null()]).optional(),
      expectedTurnId: z.string(),
      input: z.array(UserInputSchema),
      responsesapiClientMetadata: z.union([z.object({}).catchall(z.string()), z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const TurnSteerResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ turnId: z.string() }).catchall(z.json()),
);
export const TurnInterruptParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string(), turnId: z.string() }).catchall(z.json()),
);
export const TurnInterruptResponseSchema: z.ZodType = z.lazy(() => z.object({}).catchall(z.json()));
export const TurnSettingsUpdateParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      approvalsReviewer: z.union([ApprovalsReviewerSchema, z.null()]).optional(),
      effort: z.union([ReasoningEffortSchema, z.null()]).optional(),
      model: z.union([z.string(), z.null()]).optional(),
      serviceTier: z.union([z.string(), z.null()]).optional(),
      summary: z.union([ReasoningSummarySchema, z.null()]).optional(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .strict(),
);
export const TurnSettingsUpdateResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ status: TurnSettingsUpdateStatusSchema }).catchall(z.json()),
);
export const ModelListParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([z.string(), z.null()]).optional(),
      includeHidden: z.union([z.boolean(), z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ModelListResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({ data: z.array(ModelSchema), nextCursor: z.union([z.string(), z.null()]).optional() })
    .catchall(z.json()),
);
export const ThreadQueueListParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([z.string(), z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadQueueListResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      data: z.array(QueuedSubmissionSchema),
      nextCursor: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadQueueAddParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      clientUserMessageId: z.string(),
      input: z.array(UserInputSchema),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadQueueAddResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ queuedSubmission: QueuedSubmissionSchema }).catchall(z.json()),
);
export const ThreadQueueStartParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      queuedSubmissionId: z.union([z.string(), z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadQueueStartResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ turn: TurnSchema }).catchall(z.json()),
);
export const ThreadQueueUpdateParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      input: z.array(UserInputSchema),
      queuedSubmissionId: z.string(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadQueueUpdateResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ queuedSubmission: QueuedSubmissionSchema }).catchall(z.json()),
);
export const ThreadQueueDeleteParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ queuedSubmissionId: z.string(), threadId: z.string() }).catchall(z.json()),
);
export const ThreadQueueDeleteResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ deleted: z.boolean() }).catchall(z.json()),
);
export const ThreadQueueReorderParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ queuedSubmissionIds: z.array(z.string()), threadId: z.string() }).catchall(z.json()),
);
export const ThreadQueueReorderResponseSchema: z.ZodType = z.lazy(() =>
  z.object({}).catchall(z.json()),
);
export const ThreadGoalGetParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadGoalGetResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ goal: z.union([ThreadGoalSchema, z.null()]).optional() }).catchall(z.json()),
);
export const ThreadGoalSetParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      objective: z.union([z.string(), z.null()]).optional(),
      origin: z.union([ThreadGoalMutationOriginSchema, z.null()]).optional(),
      status: z.union([ThreadGoalStatusSchema, z.null()]).optional(),
      threadId: z.string(),
      tokenBudget: z.union([z.number().int(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadGoalSetResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ goal: ThreadGoalSchema }).catchall(z.json()),
);
export const ThreadGoalClearParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      origin: z.union([ThreadGoalMutationOriginSchema, z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadGoalClearResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ cleared: z.boolean() }).catchall(z.json()),
);
export const ThreadBackgroundTerminalsListParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([z.string(), z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
      threadId: z.string(),
    })
    .catchall(z.json()),
);
export const ThreadBackgroundTerminalsListResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      data: z.array(ThreadBackgroundTerminalSchema),
      nextCursor: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadBackgroundTerminalsTerminateParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ processId: z.string(), threadId: z.string() }).catchall(z.json()),
);
export const ThreadBackgroundTerminalsTerminateResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ terminated: z.boolean() }).catchall(z.json()),
);
export const ThreadBackgroundTerminalsCleanParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadBackgroundTerminalsCleanResponseSchema: z.ZodType = z.lazy(() =>
  z.object({}).catchall(z.json()),
);
export const ThreadCompactStartParamsSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadCompactStartResponseSchema: z.ZodType = z.lazy(() =>
  z.object({}).catchall(z.json()),
);
export const ListMcpServerStatusParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cursor: z.union([z.string(), z.null()]).optional(),
      detail: z.union([McpServerStatusDetailSchema, z.null()]).optional(),
      limit: z.union([z.number().int().min(0), z.null()]).optional(),
      serverName: z.union([z.string(), z.null()]).optional(),
      threadId: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ListMcpServerStatusResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      data: z.array(McpServerStatusSchema),
      nextCursor: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const CommandExecutionRequestApprovalParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      additionalPermissions: z.union([AdditionalPermissionProfileSchema, z.null()]).optional(),
      approvalId: z.union([z.string(), z.null()]).optional(),
      availableDecisions: z
        .union([z.array(CommandExecutionApprovalDecisionSchema), z.null()])
        .optional(),
      command: z.union([z.string(), z.null()]).optional(),
      commandActions: z.union([z.array(CommandActionSchema), z.null()]).optional(),
      cwd: z.union([LegacyAppPathStringSchema, z.null()]).optional(),
      environmentId: z.union([z.string(), z.null()]).optional(),
      itemId: z.string(),
      kind: CommandExecutionApprovalKindSchema.optional(),
      networkApprovalContext: z.union([NetworkApprovalContextSchema, z.null()]).optional(),
      proposedExecpolicyAmendment: z.union([z.array(z.string()), z.null()]).optional(),
      proposedNetworkPolicyAmendments: z
        .union([z.array(NetworkPolicyAmendmentSchema), z.null()])
        .optional(),
      reason: z.union([z.string(), z.null()]).optional(),
      startedAtMs: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const CommandExecutionRequestApprovalResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ decision: CommandExecutionApprovalDecisionSchema }).catchall(z.json()),
);
export const FileChangeRequestApprovalParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      grantRoot: z.union([z.string(), z.null()]).optional(),
      itemId: z.string(),
      reason: z.union([z.string(), z.null()]).optional(),
      startedAtMs: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const FileChangeRequestApprovalResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ decision: FileChangeApprovalDecisionSchema }).catchall(z.json()),
);
export const PermissionsRequestApprovalParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      cwd: LegacyAppPathStringSchema,
      environmentId: z.union([z.string(), z.null()]).optional(),
      itemId: z.string(),
      permissions: RequestPermissionProfileSchema,
      reason: z.union([z.string(), z.null()]).optional(),
      startedAtMs: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const PermissionsRequestApprovalResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      permissions: GrantedPermissionProfileSchema,
      scope: PermissionGrantScopeSchema.optional(),
      strictAutoReview: z.union([z.boolean(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ToolRequestUserInputParamsSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      autoResolutionMs: z.union([z.number().int().min(0), z.null()]).optional(),
      isBlocking: z.boolean(),
      itemId: z.string(),
      questions: z.array(ToolRequestUserInputQuestionSchema),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ToolRequestUserInputResponseSchema: z.ZodType = z.lazy(() =>
  z.object({ answers: z.object({}).catchall(ToolRequestUserInputAnswerSchema) }).catchall(z.json()),
);
export const McpServerElicitationRequestParamsSchema: z.ZodType = z.lazy(() =>
  z.union([
    z
      .object({
        _meta: z.json().optional(),
        challenge: z.string(),
        description: z.string(),
        mode: z.literal("openai/userVerification"),
        title: z.string(),
      })
      .catchall(z.json()),
    z
      .object({
        _meta: z.json().optional(),
        message: z.string(),
        mode: z.literal("form"),
        requestedSchema: McpElicitationSchemaSchema,
      })
      .catchall(z.json()),
    z
      .object({
        _meta: z.json().optional(),
        message: z.string(),
        mode: z.literal("openai/form"),
        requestedSchema: z.json(),
      })
      .catchall(z.json()),
    z
      .object({
        _meta: z.json().optional(),
        message: z.string(),
        mode: z.literal("openaiForm"),
        requestedSchema: z.json(),
      })
      .catchall(z.json()),
    z
      .object({
        _meta: z.json().optional(),
        elicitationId: z.string(),
        message: z.string(),
        mode: z.literal("url"),
        url: z.string(),
      })
      .catchall(z.json()),
  ]),
);
export const McpServerElicitationRequestResponseSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      _meta: z.json().optional(),
      action: McpServerElicitationActionSchema,
      content: z.json().optional(),
    })
    .catchall(z.json()),
);
export const ErrorNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      error: TurnErrorSchema,
      threadId: z.string(),
      turnId: z.string(),
      willRetry: z.boolean(),
    })
    .catchall(z.json()),
);
export const ThreadStartedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ thread: ThreadSchema }).catchall(z.json()),
);
export const ThreadStatusChangedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ status: ThreadStatusSchema, threadId: z.string() }).catchall(z.json()),
);
export const ThreadClosedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadRevertedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadGoalUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      goal: ThreadGoalSchema,
      threadId: z.string(),
      turnId: z.union([z.string(), z.null()]).optional(),
    })
    .catchall(z.json()),
);
export const ThreadGoalClearedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadQueueChangedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string() }).catchall(z.json()),
);
export const ThreadSettingsUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string(), threadSettings: ThreadSettingsSchema }).catchall(z.json()),
);
export const ThreadTokenUsageUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ threadId: z.string(), tokenUsage: ThreadTokenUsageSchema, turnId: z.string() })
    .catchall(z.json()),
);
export const TurnStartedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string(), turn: TurnSchema }).catchall(z.json()),
);
export const TurnCompletedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ threadId: z.string(), turn: TurnSchema }).catchall(z.json()),
);
export const TurnDiffUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ diff: z.string(), threadId: z.string(), turnId: z.string() }).catchall(z.json()),
);
export const TurnPlanUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      explanation: z.union([z.string(), z.null()]).optional(),
      plan: z.array(TurnPlanStepSchema),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ItemStartedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      item: ThreadItemSchema,
      startedAtMs: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ItemCompletedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      completedAtMs: z.number().int(),
      item: ThreadItemSchema,
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const AgentMessageDeltaNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ delta: z.string(), itemId: z.string(), threadId: z.string(), turnId: z.string() })
    .catchall(z.json()),
);
export const PlanDeltaNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ delta: z.string(), itemId: z.string(), threadId: z.string(), turnId: z.string() })
    .catchall(z.json()),
);
export const CommandExecutionOutputDeltaNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ delta: z.string(), itemId: z.string(), threadId: z.string(), turnId: z.string() })
    .catchall(z.json()),
);
export const TerminalInteractionNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      itemId: z.string(),
      processId: z.string(),
      stdin: z.string(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const FileChangePatchUpdatedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      changes: z.array(FileUpdateChangeSchema),
      itemId: z.string(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ServerRequestResolvedNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ requestId: RequestIdSchema, threadId: z.string() }).catchall(z.json()),
);
export const McpToolCallProgressNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({ itemId: z.string(), message: z.string(), threadId: z.string(), turnId: z.string() })
    .catchall(z.json()),
);
export const ReasoningSummaryTextDeltaNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      delta: z.string(),
      itemId: z.string(),
      summaryIndex: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ReasoningSummaryPartAddedNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      itemId: z.string(),
      summaryIndex: z.number().int(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const ReasoningTextDeltaNotificationSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      contentIndex: z.number().int(),
      delta: z.string(),
      itemId: z.string(),
      threadId: z.string(),
      turnId: z.string(),
    })
    .catchall(z.json()),
);
export const TurnModerationMetadataNotificationSchema: z.ZodType = z.lazy(() =>
  z.object({ metadata: z.json(), threadId: z.string(), turnId: z.string() }).catchall(z.json()),
);
