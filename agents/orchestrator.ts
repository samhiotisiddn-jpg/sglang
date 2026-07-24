import { interrupt, START, END, StateGraph } from "@langchain/langgraph";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type FractalState = {
  requestId: string;
  objective: string;
  riskLevel: "low" | "medium" | "high";
  strategy?: string;
  executionResult?: string;
  approved?: boolean;
};

class SupabaseCheckpointStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async put(threadId: string, state: FractalState): Promise<void> {
    await this.supabase.from("fm_agent_checkpoints").upsert({
      thread_id: threadId,
      state,
      updated_at: new Date().toISOString(),
    });
  }

  async get(threadId: string): Promise<FractalState | null> {
    const { data } = await this.supabase
      .from("fm_agent_checkpoints")
      .select("state")
      .eq("thread_id", threadId)
      .maybeSingle();

    return (data?.state as FractalState | undefined) ?? null;
  }
}

async function hermesStrategy(state: FractalState): Promise<Partial<FractalState>> {
  return {
    strategy: `Hermes_Strategy: Plan objective='${state.objective}' with bounded edge execution.`,
  };
}

async function kimiExecution(state: FractalState): Promise<Partial<FractalState>> {
  return {
    executionResult: `Kimi_Execution: Executed strategy for request ${state.requestId}`,
  };
}

async function humanInTheLoopGate(state: FractalState): Promise<Partial<FractalState>> {
  if (state.riskLevel === "high") {
    const approval = interrupt<{ approved: boolean }>({
      reason: "High-risk execution requires human approval before commit/deploy.",
      requestId: state.requestId,
      strategy: state.strategy,
    });

    return { approved: approval.approved };
  }

  return { approved: true };
}

export function buildFractalOrchestrator(supabaseUrl: string, supabaseServiceRoleKey: string) {
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  const checkpointer = new SupabaseCheckpointStore(supabase);

  const graph = new StateGraph<FractalState>({
    channels: {
      requestId: { value: (x: string, y?: string) => y ?? x },
      objective: { value: (x: string, y?: string) => y ?? x },
      riskLevel: { value: (x: FractalState["riskLevel"], y?: FractalState["riskLevel"]) => y ?? x },
      strategy: { value: (_x?: string, y?: string) => y },
      executionResult: { value: (_x?: string, y?: string) => y },
      approved: { value: (_x?: boolean, y?: boolean) => y },
    },
  })
    .addNode("Hermes_Strategy", hermesStrategy)
    .addNode("Kimi_Execution", kimiExecution)
    .addNode("Human_In_The_Loop_Gate", humanInTheLoopGate)
    .addEdge(START, "Hermes_Strategy")
    .addEdge("Hermes_Strategy", "Kimi_Execution")
    .addEdge("Kimi_Execution", "Human_In_The_Loop_Gate")
    .addEdge("Human_In_The_Loop_Gate", END)
    .compile({ checkpointer });

  return {
    graph,
    async invoke(threadId: string, input: FractalState) {
      await checkpointer.put(threadId, input);
      const result = await graph.invoke(input, { configurable: { thread_id: threadId } });
      await checkpointer.put(threadId, result as FractalState);
      return result;
    },
    async resume(threadId: string, approval: { approved: boolean }) {
      const current = await checkpointer.get(threadId);
      if (!current) {
        throw new Error(`No checkpoint found for thread: ${threadId}`);
      }
      const resumed = { ...current, ...approval };
      const result = await graph.invoke(resumed, { configurable: { thread_id: threadId } });
      await checkpointer.put(threadId, result as FractalState);
      return result;
    },
  };
}
