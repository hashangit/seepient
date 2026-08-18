/**
 * Seepient v2 Instance-First SDK Implementation
 *
 * Implements the contract defined in `src/foundations/contracts/sdk-fixture.ts`.
 */

import { ProviderRuntime, getDefaultProviderRuntime } from "../../domain/providers/provider-runtime.js";
import { ProviderConfigStore } from "../../domain/providers/config-store/provider-config-store.js";
import { MemoryCredentialStore } from "../../domain/providers/credentials/memory-credential-store.js";
import { AggregateInferenceAdapter } from "../../capabilities/inference/aggregate-adapter.js";
import { PiLanguageRaw } from "../../vendors/pi-ai/pi-language-raw.js";
import { OpenAIImageRaw } from "../../vendors/openai/openai-image-raw.js";
import { GoogleImageRaw } from "../../vendors/google/google-image-raw.js";
import { resolveCuratedCatalog } from "../../foundations/models-catalog.js";
import { InferenceError, InferenceErrorCode } from "../../foundations/errors.js";
import type {
  Seepient,
  CreateSeepientOptions,
  AgentOptions,
  Agent as PublicAgent,
  GenerateTextOptions,
  GenerateImageOptions,
  ResolveOptions,
  TurnResult,
  ModelAssignmentOverride,
} from "../../foundations/contracts/sdk-fixture.js";
import type {
  ContentBlock,
  CanonicalMessage,
  StreamEvent,
  InferenceResponse,
  ImageResult,
  UpstreamModel,
} from "../../foundations/schemas/inference.js";
import type { PurposeModelMap } from "../../foundations/schemas/provider-config.js";

export async function createSeepient(opts: CreateSeepientOptions = {}): Promise<Seepient> {
  let runtime: ProviderRuntime;

  if (!opts.providers && !opts.modelAssignments && !opts.credentials && !opts.overlayFile) {
    runtime = getDefaultProviderRuntime();
  } else {
    const configStore = new ProviderConfigStore(opts.overlayFile ?? ":memory:");
    if (opts.providers || opts.modelAssignments) {
      await configStore.updateOverlay(
        {
          providers: opts.providers as any,
          modelAssignments: opts.modelAssignments as any,
          retryPolicy: opts.retryPolicy as any,
        },
        0,
      );
    }

    const credentialStore = opts.credentials ?? new MemoryCredentialStore();
    const adapter = opts.adapter ?? new AggregateInferenceAdapter({
      language: new PiLanguageRaw(),
      openaiImage: new OpenAIImageRaw(),
      googleImage: new GoogleImageRaw(),
    });

    runtime = new ProviderRuntime({
      configStore,
      credentialStore,
      adapter,
    });
  }

  const initialSnapshot = await runtime.createTurnSnapshot();
  (runtime as any).currentAssignments = initialSnapshot.assignments;

  return {
    async createAgent(agentOpts: AgentOptions): Promise<PublicAgent> {
      let currentOverride: ModelAssignmentOverride | undefined = agentOpts.override ? { ...agentOpts.override } : undefined;
      const conversationMessages: CanonicalMessage[] = [];

      if (agentOpts.systemPrompt) {
        conversationMessages.push({
          role: "system",
          content: [{ type: "text", text: agentOpts.systemPrompt }],
        });
      }

      return {
        get messages() {
          return conversationMessages;
        },

        clearConversation() {
          conversationMessages.length = 0;
          if (agentOpts.systemPrompt) {
            conversationMessages.push({
              role: "system",
              content: [{ type: "text", text: agentOpts.systemPrompt }],
            });
          }
        },

        async switchModel(override: ModelAssignmentOverride) {
          currentOverride = { ...override };
        },

        async promoteOverrideToAssignment(scope: "provider:admin", expectedRevision: number) {
          if (scope !== "provider:admin") {
            throw new InferenceError({
              code: "invalid_request",
              message: "Scope 'provider:admin' required to promote override to assignment",
              retryable: false,
            });
          }
          if (!currentOverride?.model) {
            throw new InferenceError({
              code: "invalid_request",
              message: "No active model override to promote",
              retryable: false,
            });
          }
          const snapshot = await runtime.createTurnSnapshot();
          const resolvedPlan = await runtime.resolvePlan(
            snapshot,
            agentOpts.purpose,
            agentOpts.tier,
            currentOverride,
          );
          const tier = agentOpts.tier ?? "standard";
          const res = await runtime.updateOverlay(
            {
              modelAssignments: {
                [agentOpts.purpose]: {
                  [tier]: {
                    providerAccount: currentOverride.providerAccount ?? resolvedPlan.selectedTarget.providerAccount,
                    model: currentOverride.model,
                    thinkingLevel: currentOverride.thinkingLevel,
                  },
                },
              } as any,
            },
            expectedRevision,
          );
          return { revision: res.revision };
        },

        async run(input: string | ContentBlock[]): Promise<TurnResult> {
          const userContent = typeof input === "string" ? [{ type: "text" as const, text: input }] : (input.filter((b) => b.type === "text" || b.type === "image") as any);
          conversationMessages.push({
            role: "user",
            content: userContent,
          });

          let currentStep = 0;
          const maxSteps = 10;
          let snapshot = await runtime.createTurnSnapshot();
          let plan = await runtime.resolvePlan(
            snapshot,
            agentOpts.purpose,
            agentOpts.tier,
            currentOverride,
          );

          let finalStopReason: any = "end_turn";
          let finalUsage: any;
          let finalContent: ContentBlock[] = [];

          while (currentStep < maxSteps) {
            currentStep++;
            let fullText = "";
            let toolCalls: Array<{ id: string; name: string; input: string }> = [];
            let currentToolCall: { id: string; name: string; input: string } | null = null;
            let stepStopReason: any = "end_turn";
            let stepUsage: any;

            for await (const ev of runtime.executeLanguage(
              plan,
              {
                messages: conversationMessages,
                tools: agentOpts.tools as any,
              },
            )) {
              if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
                fullText += ev.delta.text;
              } else if (
                ev.type === "content_block_start" &&
                ((ev.block?.type as any) === "tool_call" || ev.block?.type === "tool_use")
              ) {
                currentToolCall = { id: (ev.block as any).id, name: (ev.block as any).name, input: "" };
              } else if (ev.type === "content_block_delta" && ev.delta.type === "tool_input_delta") {
                if (currentToolCall) {
                  currentToolCall.input += ev.delta.partialJson;
                }
              } else if (ev.type === "content_block_stop") {
                if (currentToolCall) {
                  toolCalls.push(currentToolCall);
                  currentToolCall = null;
                }
              } else if (ev.type === "finish") {
                stepStopReason = ev.stopReason;
                stepUsage = ev.usage;
              } else if (ev.type === "error") {
                throw new InferenceError({
                  code: ev.error.code as InferenceErrorCode,
                  message: ev.error.message,
                  retryable: ev.error.retryable,
                });
              }
            }

            finalStopReason = stepStopReason;
            finalUsage = stepUsage;

            const assistantBlocks: ContentBlock[] = [];
            if (fullText) {
              assistantBlocks.push({ type: "text", text: fullText });
            }
            for (const tc of toolCalls) {
              let parsedInput = {};
              try { parsedInput = JSON.parse(tc.input); } catch {}
              assistantBlocks.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: parsedInput,
              } as any);
            }

            conversationMessages.push({
              role: "assistant",
              content: assistantBlocks as any,
            });
            finalContent = assistantBlocks;

            if (toolCalls.length === 0 || stepStopReason !== "tool_use") {
              break;
            }

            // Execute tools and append tool_result
            const toolResults: ContentBlock[] = [];
            for (const tc of toolCalls) {
              const toolDef = (agentOpts.tools as any[])?.find((t) => t.name === tc.name);
              let output = "";
              let isError = false;
              if (toolDef && typeof toolDef.execute === "function") {
                try {
                  let parsed = {};
                  try { parsed = JSON.parse(tc.input); } catch {}
                  const res = await toolDef.execute(parsed, { runtime });
                  output = typeof res === "string" ? res : JSON.stringify(res);
                } catch (err: any) {
                  output = `Error: ${err.message}`;
                  isError = true;
                }
              } else {
                output = `Error: Tool "${tc.name}" is not implemented`;
                isError = true;
              }

              toolResults.push({
                type: "tool_result",
                toolUseId: tc.id,
                content: output,
                isError,
              } as any);
            }

            conversationMessages.push({
              role: "user",
              content: toolResults as any,
            });

            snapshot = await runtime.createTurnSnapshot();
            (runtime as any).currentAssignments = snapshot.assignments;
            plan = await runtime.resolvePlan(
              snapshot,
              agentOpts.purpose,
              agentOpts.tier,
              currentOverride,
            );
          }

          return {
            stopReason: finalStopReason,
            content: finalContent,
            usage: finalUsage,
            servedBy: {
              providerAccount: plan.selectedTarget.providerAccount,
              model: plan.selectedTarget.model,
              thinkingLevel: plan.selectedTarget.thinkingLevel,
            },
          };
        },

        async stream(input: string | ContentBlock[]): Promise<AsyncIterable<StreamEvent>> {
          const userContent = typeof input === "string" ? [{ type: "text" as const, text: input }] : (input.filter((b) => b.type === "text" || b.type === "image") as any);
          const userMsg: CanonicalMessage = {
            role: "user",
            content: userContent,
          };
          conversationMessages.push(userMsg);

          const snapshot = await runtime.createTurnSnapshot();
          (runtime as any).currentAssignments = snapshot.assignments;
          const plan = await runtime.resolvePlan(
            snapshot,
            agentOpts.purpose,
            agentOpts.tier,
            currentOverride,
          );

          async function* generateEvents(): AsyncGenerator<StreamEvent> {
            let fullText = "";
            let success = false;
            try {
              for await (const event of runtime.executeLanguage(plan, {
                messages: conversationMessages,
                tools: agentOpts.tools as any,
              })) {
                if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
                  fullText += event.delta.text;
                }
                yield event;
                if (event.type === "finish") {
                  success = true;
                }
              }
              if (success && fullText) {
                conversationMessages.push({
                  role: "assistant",
                  content: [{ type: "text", text: fullText }],
                });
              }
            } finally {
              if (!success) {
                const idx = conversationMessages.lastIndexOf(userMsg);
                if (idx >= 0) conversationMessages.splice(idx, 1);
              }
            }
          }

          return generateEvents();
        },

        async dispose(): Promise<void> {
          conversationMessages.length = 0;
        },
      };
    },

    async generateText(opts: GenerateTextOptions): Promise<InferenceResponse> {
      const text = typeof opts.prompt === "string" ? opts.prompt : opts.prompt.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard", opts.override);
      const canonicalMessages: CanonicalMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text }],
        },
      ];

      let fullText = "";
      let stopReason: any = "end_turn";
      let usage: any;

      for await (const ev of runtime.executeLanguage(plan, {
        messages: canonicalMessages,
      })) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          fullText += ev.delta.text;
        } else if (ev.type === "finish") {
          stopReason = ev.stopReason;
          usage = ev.usage;
        }
      }

      return {
        message: {
          role: "assistant",
          content: [{ type: "text", text: fullText }],
        },
        stopReason,
        usage,
      };
    },

    async streamText(opts: any): Promise<AsyncIterable<StreamEvent>> {
      const text = typeof opts.prompt === "string" ? opts.prompt : opts.prompt.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "text", "standard", opts.override);
      const canonicalMessages: CanonicalMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text }],
        },
      ];

      return runtime.executeLanguage(plan, {
        messages: canonicalMessages,
      });
    },

    async generateImage(opts: any): Promise<any> {
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, "image-generation", "standard", opts.override);

      const res = await runtime.executeImage(plan, {
        prompt: opts.prompt,
        operation: opts.operation,
        aspectRatio: opts.aspectRatio,
        qualityPreset: opts.qualityPreset,
        inputImage: opts.image ?? opts.inputImage,
        mask: opts.mask,
        count: opts.count,
        style: opts.style,
      });

      return {
        images: res.images.map((img: any) => ({
          mimeType: img.mimeType as any,
          bytes: img.bytes,
          format: img.format,
          aspectRatio: img.aspectRatio,
          revisedPrompt: img.revisedPrompt,
        })),
        usage: {
          imagesGenerated: res.images.length,
          cost: res.usage?.cost ?? (res as any).cost,
        },
        servedBy: {
          providerAccount: plan.selectedTarget.providerAccount,
          model: plan.selectedTarget.model,
        },
      };
    },

    async resolve(opts: any): Promise<any> {
      const snapshot = await runtime.createTurnSnapshot();
      const plan = await runtime.resolvePlan(snapshot, opts.purpose, opts.tier, opts.override);

      const model = snapshot.catalog.find((m: any) => m.id === plan.selectedTarget.model) ?? {
        id: plan.selectedTarget.model,
        displayName: plan.selectedTarget.model,
        provider: plan.selectedTarget.providerAccount,
        capabilities: {
          reasoning: !!plan.selectedTarget.thinkingLevel,
          images: opts.purpose === "image-generation",
          streaming: true,
          vision: false,
        },
        provenance: "user-declared" as const,
      };

      return {
        model,
        providerAccount: plan.selectedTarget.providerAccount,
        thinkingLevel: plan.selectedTarget.thinkingLevel,
      };
    },

    getAssignments(): PurposeModelMap {
      return (runtime as any).currentAssignments ?? {};
    },

    async getCatalog(): Promise<readonly UpstreamModel[]> {
      const snapshot = await runtime.createTurnSnapshot();
      return snapshot.catalog.length > 0 ? snapshot.catalog : resolveCuratedCatalog();
    },

    async reload(): Promise<{ revision: number }> {
      const snapshot = await runtime.createTurnSnapshot();
      (runtime as any).currentAssignments = snapshot.assignments;
      return { revision: snapshot.revision };
    },

    async dispose(): Promise<void> {
      runtime.removeAllListeners();
    },
  };
}
