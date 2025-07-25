import { ShallowRef, type Ref } from "vue";

import debounce from "lodash.debounce";
import {
  type LogEvent,
  type JSONObject,
  LogEntry,
  SimpleLogEntry,
  asLogEntry,
  ContainerEventLogEntry,
  ComplexLogEntry,
  SkippedLogsEntry,
  LoadMoreLogEntry,
} from "@/models/LogEntry";
import { Service, Stack } from "@/models/Stack";
import { Container, GroupedContainers } from "@/models/Container";

const { isSearching, debouncedSearchFilter } = useSearchFilter();

function parseMessage(data: string): LogEntry<string | JSONObject> {
  const e = JSON.parse(data) as LogEvent;
  return asLogEntry(e);
}

export function useContainerStream(container: Ref<Container>): LogStreamSource {
  const url = computed(() => `/api/hosts/${container.value.host}/containers/${container.value.id}/logs/stream`);
  return useLogStream(url, container);
}

export function useHostStream(host: Ref<Host>): LogStreamSource {
  return useLogStream(computed(() => `/api/hosts/${host.value.id}/logs/stream`));
}

export function useStackStream(stack: Ref<Stack>): LogStreamSource {
  return useLogStream(computed(() => `/api/stacks/${stack.value.name}/logs/stream`));
}

export function useGroupedStream(group: Ref<GroupedContainers>): LogStreamSource {
  return useLogStream(computed(() => `/api/groups/${group.value.name}/logs/stream`));
}

export function useMergedStream(containers: Ref<Container[]>): LogStreamSource {
  const url = computed(() => {
    const ids = containers.value.map((c) => c.id).join(",");
    return `/api/hosts/${containers.value[0].host}/logs/mergedStream/${ids}`;
  });

  return useLogStream(url);
}

export function useServiceStream(service: Ref<Service>): LogStreamSource {
  return useLogStream(computed(() => `/api/services/${service.value.name}/logs/stream`));
}

export type LogStreamSource = ReturnType<typeof useLogStream>;

function useLogStream(url: Ref<string>, container?: Ref<Container>) {
  const messages: ShallowRef<LogEntry<string | JSONObject>[]> = shallowRef([]);
  const buffer: ShallowRef<LogEntry<string | JSONObject>[]> = shallowRef([]);
  const opened = ref(false);
  const loading = ref(true);
  const error = ref(false);
  const { paused: scrollingPaused } = useScrollContext();
  const { streamConfig, hasComplexLogs, levels, loadingMore } = useLoggingContext();
  let initial = true;

  function flushNow() {
    if (messages.value.length + buffer.value.length > config.maxLogs) {
      if (scrollingPaused.value === true) {
        if (messages.value.at(-1) instanceof SkippedLogsEntry) {
          const lastEvent = messages.value.at(-1) as SkippedLogsEntry;
          const lastItem = buffer.value.at(-1) as LogEntry<string | JSONObject>;
          lastEvent.addSkippedEntries(buffer.value.length, lastItem);
        } else {
          const firstItem = buffer.value.at(0) as LogEntry<string | JSONObject>;
          const lastItem = buffer.value.at(-1) as LogEntry<string | JSONObject>;
          messages.value = [
            ...messages.value,
            new SkippedLogsEntry(new Date(), buffer.value.length, firstItem, lastItem, loadSkippedLogs),
          ];
        }
        buffer.value = [];
      } else {
        if (buffer.value.length > config.maxLogs / 2) {
          messages.value = buffer.value.slice(-config.maxLogs / 2);
        } else {
          messages.value = [...messages.value, ...buffer.value].slice(-config.maxLogs);
        }
        buffer.value = [];
      }
    } else {
      if (initial) {
        // sort the buffer the very first time because of multiple logs in parallel
        buffer.value.sort((a, b) => a.date.getTime() - b.date.getTime());

        if (container) {
          const loadMoreItem = new LoadMoreLogEntry(new Date(), loadOlderLogs);
          messages.value = [loadMoreItem];
        }
        initial = false;
      }
      messages.value = [...messages.value, ...buffer.value];
      buffer.value = [];
    }
  }
  const flushBuffer = debounce(flushNow, 250, { maxWait: 1000 });
  let es: EventSource | null = null;

  function close() {
    if (es) {
      es.close();
      es = null;
    }
  }

  function clearMessages() {
    flushBuffer.cancel();
    messages.value = [];
    buffer.value = [];
  }

  const params = computed(() => {
    const params = new URLSearchParams();
    if (streamConfig.value.stdout) params.append("stdout", "1");
    if (streamConfig.value.stderr) params.append("stderr", "1");
    if (isSearching.value) params.append("filter", debouncedSearchFilter.value);
    for (const level of levels.value) {
      params.append("levels", level);
    }
    return params;
  });

  const urlWithParams = computed(() => withBase(`${url.value}?${params.value.toString()}`));

  function connect({ clear } = { clear: true }) {
    close();
    if (clear) clearMessages();
    opened.value = false;
    loading.value = true;
    error.value = false;
    initial = true;
    es = new EventSource(urlWithParams.value);
    es.addEventListener("container-event", (e) => {
      const event = JSON.parse((e as MessageEvent).data) as {
        actorId: string;
        name: "container-stopped" | "container-started";
        time: string;
      };
      const containerEvent = new ContainerEventLogEntry(
        event.name == "container-started" ? "Container started" : "Container stopped",
        event.actorId,
        new Date(event.time),
        event.name,
      );

      buffer.value = [...buffer.value, containerEvent];
      flushBuffer();
      flushBuffer.flush();
    });

    es.addEventListener("logs-backfill", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as LogEvent[];
      const logs = data.map((e) => asLogEntry(e));
      messages.value = [...logs, ...messages.value];
    });

    es.onmessage = (e) => {
      if (e.data) {
        buffer.value = [...buffer.value, parseMessage(e.data)];
        flushBuffer();
      }
    };
    es.onerror = () => {
      error.value = true;
    };
    es.onopen = () => {
      loading.value = false;
      opened.value = true;
      error.value = false;
    };
  }

  watch(urlWithParams, () => connect(), { immediate: true });

  async function loadOlderLogs(entry: LoadMoreLogEntry) {
    if (!(messages.value[0] instanceof LoadMoreLogEntry)) throw new Error("No loadMoreLogEntry on first item");
    if (!container) throw new Error("No container");

    const [loader, ...existingLogs] = messages.value;
    const to = existingLogs[0].date;
    const lastSeenId = existingLogs[0].id;
    const last = messages.value[Math.min(messages.value.length - 1, 300)].date;
    const delta = to.getTime() - last.getTime();
    const from = new Date(to.getTime() + delta);
    try {
      loadingMore.value = true;
      const { logs: newLogs, signal } = await loadBetween(container, params, from, to, {
        min: 100,
        lastSeenId,
      });
      if (newLogs && signal.aborted === false) {
        messages.value = [loader, ...newLogs, ...existingLogs];
      }
    } catch (error) {
      console.error(error);
    } finally {
      loadingMore.value = false;
    }
  }

  async function loadSkippedLogs(entry: SkippedLogsEntry) {
    if (!container) throw new Error("No container");

    const from = entry.firstSkipped.date;
    const to = entry.lastSkippedLog.date;
    const lastSeenId = entry.lastSkippedLog.id;
    try {
      loadingMore.value = true;
      const { logs, signal } = await loadBetween(container, params, from, to, { lastSeenId });
      if (logs && signal.aborted === false) {
        messages.value = messages.value.slice(logs.length).flatMap((log) => (log === entry ? logs : [log]));
      }
    } catch (error) {
      console.error(error);
    } finally {
      loadingMore.value = false;
    }
  }

  onScopeDispose(() => close());

  watch(messages, () => {
    if (messages.value.length > 1) {
      hasComplexLogs.value = messages.value.some((m) => m instanceof ComplexLogEntry);
    }
  });

  // 维护隐藏日志的状态，而不是直接从messages数组中删除
  const hiddenLogIds = ref(new Set<number>());

  function hideLogEntry(logId: number) {
    const targetEntry = messages.value.find(message => message.id === logId);
    if (!targetEntry) return;

    // If it's a simple log entry with position info, hide the entire block
    // This uses the same logic as the green vertical bar (LogLevel component)
    if (targetEntry instanceof SimpleLogEntry && targetEntry.position) {
      const targetIndex = messages.value.findIndex(message => message.id === logId);
      const blockIds = new Set<number>();

      // Find the start of the block by going backwards
      let startIndex = targetIndex;
      while (startIndex >= 0) {
        const entry = messages.value[startIndex];
        if (entry instanceof SimpleLogEntry &&
            entry.containerID === targetEntry.containerID &&
            entry.position) {
          blockIds.add(entry.id);
          if (entry.position === 'start') break;
          startIndex--;
        } else {
          break;
        }
      }

      // Find the end of the block by going forwards
      let endIndex = targetIndex + 1;
      while (endIndex < messages.value.length) {
        const entry = messages.value[endIndex];
        if (entry instanceof SimpleLogEntry &&
            entry.containerID === targetEntry.containerID &&
            entry.position) {
          blockIds.add(entry.id);
          if (entry.position === 'end') break;
          endIndex++;
        } else {
          break;
        }
      }

      // 将整个块的ID添加到隐藏列表中，而不是从messages数组中删除
      blockIds.forEach(id => hiddenLogIds.value.add(id));
      return;
    }

    // Default behavior: hide single entry by adding to hidden set
    hiddenLogIds.value.add(logId);
  }

  // 创建过滤后的消息计算属性，排除隐藏的日志
  const visibleMessages = computed(() => {
    return messages.value.filter(message => !hiddenLogIds.value.has(message.id));
  });

  return {
    messages: visibleMessages,
    opened,
    error,
    loading,
    hideLogEntry,
  };
}

export async function loadBetween(
  container: Ref<Container>,
  params: Ref<URLSearchParams>,
  from: Date,
  to: Date,
  { lastSeenId, min, maxStart }: { lastSeenId?: number; min?: number; maxStart?: number } = {},
) {
  const url = computed(() => `/api/hosts/${container.value.host}/containers/${container.value.id}/logs`);
  const abortController = new AbortController();
  const signal = abortController.signal;

  const urlWithMoreParams = computed(() => {
    const loadMoreParams = new URLSearchParams(params.value);
    loadMoreParams.append("from", from.toISOString());
    loadMoreParams.append("to", to.toISOString());
    if (min) {
      loadMoreParams.append("min", String(min));
    }
    if (maxStart) {
      loadMoreParams.append("maxStart", String(maxStart));
    }
    if (lastSeenId) {
      loadMoreParams.append("lastSeenId", String(lastSeenId));
    }
    return withBase(`${url.value}?${loadMoreParams.toString()}`);
  });
  const stopWatcher = watchOnce(urlWithMoreParams, () => abortController.abort("stream changed"));
  const logs = await (await fetch(urlWithMoreParams.value, { signal })).text();
  stopWatcher();

  if (!logs) return { logs: [], signal };

  return {
    logs: logs
      .trim()
      .split("\n")
      .map((line) => parseMessage(line)),
    signal,
  };
}
