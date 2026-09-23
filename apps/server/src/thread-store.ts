import { type BaseEvent, compactEvents, EventType, type Message } from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { finalizeRunEvents } from "@copilotkit/shared";
import { type Observable, ReplaySubject } from "rxjs";
import type { Store } from "./db.ts";

// OpenMuse is a single-owner deployment (see auth.ts); every session resolves to this owner.
export const THREAD_OWNER = "local-user";
const THREADS = "chat-threads";
const RUNS = "chat-runs";

export interface LocalThread {
  id: string;
  agentId: string;
  name: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}
interface StoredRun {
  id: string;
  threadId: string;
  runId: string;
  agentId: string;
  parentRunId: string | null;
  seq: number;
  events: BaseEvent[];
  createdAt: number;
}
interface LiveRun {
  runId: string;
  agent: AgentRunnerRunRequest["agent"];
  subject: ReplaySubject<BaseEvent>;
  control: { stopRequested: boolean };
}

const messageIdOf = (event: BaseEvent) =>
  "messageId" in event && typeof event.messageId === "string" ? event.messageId : undefined;

/**
 * Durable replacement for CopilotKit's InMemoryAgentRunner. It keeps the runtime's
 * local thread endpoints (list, messages, events, state, connect replay) working
 * without CopilotKit Intelligence, and writes every finished run through to the
 * OpenMuse store. The runtime calls the thread readers synchronously, so an
 * in-process index is hydrated from the store on open.
 */
export class LocalThreadRunner extends AgentRunner {
  override readonly ɵsupportsLocalThreadEndpoints = true as const;
  private readonly threads = new Map<string, LocalThread>();
  private readonly runs = new Map<string, StoredRun[]>();
  private readonly live = new Map<string, LiveRun>();
  // Writes are applied in order so a rename can never be overwritten by an older snapshot.
  private writes: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly db: Store,
    private readonly owner: string,
  ) {
    super();
  }

  static async open(db: Store, owner = THREAD_OWNER): Promise<LocalThreadRunner> {
    const runner = new LocalThreadRunner(db, owner);
    for (const thread of await db.list<LocalThread>(owner, THREADS))
      runner.threads.set(thread.id, thread);
    const runs = await db.list<StoredRun>(owner, RUNS);
    runs.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
    for (const run of runs) {
      const list = runner.runs.get(run.threadId) ?? [];
      list.push(run);
      runner.runs.set(run.threadId, list);
    }
    return runner;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, input, agent } = request;
    if (this.live.has(threadId)) throw new Error("Thread already running");
    const history = this.runs.get(threadId) ?? [];
    const historicIds = new Set<string>();
    for (const run of history)
      for (const event of run.events) {
        const id = messageIdOf(event);
        if (id) historicIds.add(id);
        if (event.type === EventType.RUN_STARTED)
          for (const message of (event as { input?: { messages?: Message[] } }).input?.messages ??
            [])
            historicIds.add(message.id);
      }
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const runSubject = new ReplaySubject<BaseEvent>(Infinity);
    const live: LiveRun = { runId: input.runId, agent, subject, control: { stopRequested: false } };
    this.live.set(threadId, live);
    const events: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      runSubject.next(event);
      subject.next(event);
    };
    const finalize = (interruptionMessage?: string) => {
      const emitted = events.length;
      for (const event of finalizeRunEvents(events, {
        stopRequested: live.control.stopRequested,
        ...(interruptionMessage !== undefined ? { interruptionMessage } : {}),
      }))
        emit(event);
      if (interruptionMessage === undefined || emitted > 0)
        this.append(threadId, {
          runId: input.runId,
          agentId: agent.agentId ?? "default",
          parentRunId: history.at(-1)?.runId ?? null,
          events: compactEvents(events),
          messages: Array.isArray(agent.messages) ? [...agent.messages] : [],
        });
      if (this.live.get(threadId) === live) this.live.delete(threadId);
      runSubject.complete();
      subject.complete();
    };
    void agent
      .runAgent(input, {
        onEvent: ({ event }) => {
          if (event.type === EventType.RUN_STARTED) {
            const started = event as BaseEvent & { input?: unknown };
            if (!started.input)
              started.input = {
                ...input,
                ...(input.messages
                  ? { messages: input.messages.filter((message) => !historicIds.has(message.id)) }
                  : {}),
              };
          }
          events.push(event);
          emit(event);
        },
      })
      .then(
        () => finalize(),
        (error: unknown) => finalize(error instanceof Error ? error.message : String(error)),
      );
    return runSubject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const connection = new ReplaySubject<BaseEvent>(Infinity);
    const emitted = new Set<string>();
    for (const event of this.getThreadEvents(request.threadId)) {
      connection.next(event);
      const id = messageIdOf(event);
      if (id) emitted.add(id);
    }
    const live = this.live.get(request.threadId);
    if (!live) {
      connection.complete();
      return connection.asObservable();
    }
    live.subject.subscribe({
      next: (event) => {
        const id = messageIdOf(event);
        if (!id || !emitted.has(id)) connection.next(event);
      },
      complete: () => connection.complete(),
      error: (error) => connection.error(error),
    });
    return connection.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.live.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const live = this.live.get(request.threadId);
    if (!live || live.control.stopRequested) return Promise.resolve(false);
    if (request.runId !== undefined && request.runId !== live.runId) return Promise.resolve(false);
    live.control.stopRequested = true;
    try {
      live.agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error("Failed to abort agent run", error);
      live.control.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  listThreads() {
    return [...this.threads.values()]
      .filter((thread) => this.runs.get(thread.id)?.length)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((thread) => ({
        id: thread.id,
        name: thread.name,
        agentId: thread.agentId,
        organizationId: "",
        createdById: this.owner,
        archived: thread.archived,
        createdAt: new Date(thread.createdAt).toISOString(),
        updatedAt: new Date(thread.updatedAt).toISOString(),
      }));
  }

  getThreadMessages(threadId: string): Message[] {
    return [...(this.threads.get(threadId)?.messages ?? [])];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const runs = this.runs.get(threadId);
    return runs?.length ? compactEvents(runs.flatMap((run) => run.events)) : [];
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type !== EventType.STATE_SNAPSHOT) continue;
      const snapshot = (event as { snapshot?: unknown }).snapshot;
      return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
        ? { ...(snapshot as Record<string, unknown>) }
        : null;
    }
    return null;
  }

  /** The runtime exposes POST /threads/clear locally; durable history is never wiped by it. */
  clearThreads(): void {}

  hasHistory(threadId: string): boolean {
    return Boolean(this.runs.get(threadId)?.length);
  }

  getThread(threadId: string): LocalThread | undefined {
    return this.threads.get(threadId);
  }

  async updateThread(
    threadId: string,
    changes: { name?: string | null; archived?: boolean },
  ): Promise<LocalThread | undefined> {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    const next = { ...thread, ...changes };
    this.threads.set(threadId, next);
    await this.write(() => this.db.put(this.owner, THREADS, next));
    return next;
  }

  async deleteThread(threadId: string): Promise<boolean> {
    if (this.live.has(threadId)) throw new Error("Stop the conversation before deleting it");
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    const runs = this.runs.get(threadId) ?? [];
    this.threads.delete(threadId);
    this.runs.delete(threadId);
    await this.write(async () => {
      for (const run of runs) await this.db.remove(this.owner, RUNS, run.id);
      await this.db.remove(this.owner, THREADS, threadId);
    });
    return true;
  }

  /** Seeds a thread with a message snapshot, e.g. the pre-thread local conversation. */
  async importMessages(threadId: string, messages: Message[], agentId = "default") {
    if (this.hasHistory(threadId) || !messages.length) return;
    const runId = `import-${threadId}`;
    this.append(threadId, {
      runId,
      agentId,
      parentRunId: null,
      events: [
        { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
        { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent,
        { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent,
      ],
      messages,
    });
    await this.flush();
  }

  /** Resolves once every write-through from finished runs has reached the store. */
  async flush(): Promise<void> {
    await this.writes;
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => undefined);
    return result;
  }

  private append(
    threadId: string,
    run: Omit<StoredRun, "id" | "threadId" | "seq" | "createdAt"> & { messages: Message[] },
  ) {
    const now = Date.now();
    const runs = this.runs.get(threadId) ?? [];
    const { messages, ...rest } = run;
    const stored: StoredRun = {
      ...rest,
      id: `${threadId}:${run.runId}`,
      threadId,
      seq: (runs.at(-1)?.seq ?? -1) + 1,
      createdAt: now,
    };
    runs.push(stored);
    this.runs.set(threadId, runs);
    const existing = this.threads.get(threadId);
    const thread: LocalThread = {
      id: threadId,
      agentId: existing?.agentId ?? run.agentId,
      name: existing?.name ?? null,
      archived: existing?.archived ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: messages.length ? messages : (existing?.messages ?? []),
    };
    this.threads.set(threadId, thread);
    void this.write(async () => {
      await this.db.put(this.owner, RUNS, stored);
      await this.db.put(this.owner, THREADS, thread);
    }).catch((error) => console.error("Failed to persist conversation run", threadId, error));
  }
}
