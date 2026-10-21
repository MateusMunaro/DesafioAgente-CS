import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { GraphDeps } from "./deps.js";
import {
  afterClarification,
  afterConfirm,
  afterEnrich,
  afterFetch,
  afterInputGuard,
  afterOutputGuard,
  afterPolicy,
  afterRoute,
} from "./edges.js";
import { createNodes } from "./nodes.js";
import { AgentState } from "./state.js";

/**
 * Builds the support graph (see the flow diagram in the README).
 * Only `understand` (classifier) and `compose` (composer) reach an LLM, through GraphDeps.
 */
export function buildSupportGraph(deps: GraphDeps, checkpointer: BaseCheckpointSaver) {
  const n = createNodes(deps);
  return new StateGraph(AgentState)
    .addNode("ingest", n.ingest)
    .addNode("input_guard", n.input_guard)
    .addNode("understand", n.understand)
    .addNode("route", n.route)
    .addNode("ask_clarification", n.ask_clarification)
    .addNode("fetch_order", n.fetch_order)
    .addNode("enrich_products", n.enrich_products)
    .addNode("policy_check", n.policy_check)
    .addNode("confirm", n.confirm)
    .addNode("execute_cancel", n.execute_cancel)
    .addNode("handoff", n.handoff)
    .addNode("compose", n.compose)
    .addNode("output_guard", n.output_guard)
    .addNode("fallback", n.fallback)
    .addNode("refuse", n.refuse)
    .addNode("send", n.send)
    .addEdge(START, "ingest")
    .addEdge("ingest", "input_guard")
    .addConditionalEdges("input_guard", afterInputGuard, ["understand", "refuse", "handoff"])
    .addEdge("understand", "route")
    .addConditionalEdges("route", afterRoute, ["refuse", "handoff", "compose", "ask_clarification", "fetch_order"])
    .addConditionalEdges("ask_clarification", afterClarification, ["handoff", "send"])
    .addConditionalEdges("fetch_order", afterFetch, ["enrich_products", "compose", "handoff"])
    .addConditionalEdges("enrich_products", afterEnrich, ["policy_check", "compose", "handoff"])
    .addConditionalEdges("policy_check", afterPolicy, ["confirm", "compose", "handoff"])
    .addConditionalEdges("confirm", afterConfirm(deps.clock), ["execute_cancel", "confirm", "understand", "fetch_order", "compose", "fallback"])
    .addEdge("execute_cancel", "compose")
    .addEdge("handoff", "compose")
    .addEdge("compose", "output_guard")
    .addConditionalEdges("output_guard", afterOutputGuard, ["send", "fallback"])
    .addEdge("fallback", "send")
    .addEdge("refuse", "send")
    .addEdge("send", END)
    .compile({ checkpointer });
}

export type SupportGraph = ReturnType<typeof buildSupportGraph>;
