import { HistoricalContainer } from "@/models/Container";
import { JSONObject, LoadMoreLogEntry, LogEntry, SimpleLogEntry } from "@/models/LogEntry";
import { ShallowRef } from "vue";
import { loadBetween } from "@/composable/eventStreams";

export function useHistoricalContainerLog(historicalContainer: Ref<HistoricalContainer>): LogStreamSource {
  const messages: ShallowRef<LogEntry<string | JSONObject>[]> = shallowRef([]);
  const opened = ref(false);
  const loading = ref(true);
  const error = ref(false);
  const container = toRef(() => historicalContainer.value.container);

  const { streamConfig, levels, loadingMore } = useLoggingContext();
  const { isSearching, debouncedSearchFilter } = useSearchFilter();

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

  const route = useRoute();
  async function loadLogs() {
    loadingMore.value = true;
    try {
      const lastSeenId = route.query.logId ? +route.query.logId : undefined;
      const [{ logs: before }, { logs: after }] = await Promise.all([
        loadBetween(
          container,
          params,
          new Date(historicalContainer.value.date.getTime() - 1000 * 60 * 5),
          new Date(historicalContainer.value.date.getTime() + 1000),
          {
            min: 50,
            lastSeenId,
          },
        ),
        loadBetween(container, params, historicalContainer.value.date, new Date(), {
          maxStart: 50,
        }),
      ]);
      const loaderOlder = new LoadMoreLogEntry(new Date(), loadOlderLogs);
      const loadNewer = new LoadMoreLogEntry(new Date(), loadNewerLogs, false);
      messages.value = [loaderOlder, ...before, ...after, loadNewer];
      loading.value = false;
      opened.value = true;
    } catch (error) {
      console.error(error);
    } finally {
      loadingMore.value = false;
    }
  }

  watchArray([params, container], loadLogs, { immediate: true });

  async function loadOlderLogs(entry: LoadMoreLogEntry) {
    loadingMore.value = true;
    try {
      const item = messages.value[1];
      const { logs, signal } = await loadBetween(
        container,
        params,
        new Date(item.date.getTime() - 1000 * 60 * 5),
        item.date,
        {
          min: 200,
          lastSeenId: item.id,
        },
      );

      if (signal.aborted) {
        return;
      }

      if (!logs.length) {
        return;
      }

      const [loader, ...rest] = messages.value;
      messages.value = [loader, ...logs, ...rest];
    } catch (error) {
      console.error(error);
    } finally {
      loadingMore.value = false;
    }
  }

  async function loadNewerLogs(entry: LoadMoreLogEntry) {
    loadingMore.value = true;
    try {
      const item = messages.value.at(-2)!;
      const { logs, signal } = await loadBetween(container, params, item.date, new Date(), {
        maxStart: 100,
      });

      if (signal.aborted) {
        return;
      }

      if (!logs.length) {
        return;
      }

      const loader = messages.value.at(-1)!;
      const rest = messages.value.slice(0, -1);
      messages.value = [...rest, ...logs, loader];
    } catch (error) {
      console.error(error);
    } finally {
      loadingMore.value = false;
    }
  }

  // 维护隐藏日志的状态，而不是直接从messages数组中删除
  const hiddenLogIds = ref(new Set<number>());

  async function hideLogEntry(logId: number) {
    const targetEntry = messages.value.find(message => message.id === logId);
    if (!targetEntry) return;

    // If it's a simple log entry with position info, hide the entire block
    // This uses the same logic as the green vertical bar (LogLevel component)
    if (targetEntry instanceof SimpleLogEntry && targetEntry.position) {
      await hideCompleteLogBlock(logId, targetEntry);
      return;
    }

    // Default behavior: hide single entry by adding to hidden set
    hiddenLogIds.value.add(logId);
  }

  async function hideCompleteLogBlock(logId: number, targetEntry: SimpleLogEntry) {
    const targetIndex = messages.value.findIndex(message => message.id === logId);
    const blockIds = new Set<number>();
    let foundStart = false;

    // Find the start of the block by going backwards
    let startIndex = targetIndex;
    while (startIndex >= 0) {
      const entry = messages.value[startIndex];
      if (entry instanceof SimpleLogEntry &&
          entry.containerID === targetEntry.containerID &&
          entry.position) {
        blockIds.add(entry.id);
        if (entry.position === 'start') {
          foundStart = true;
          break;
        }
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

    // If we haven't found the start of the block, we need to load more logs
    if (!foundStart && startIndex >= 0) {
      const firstEntry = messages.value[startIndex + 1];
      if (firstEntry && firstEntry instanceof SimpleLogEntry) {
        try {
          loadingMore.value = true;
          // Load more logs before the first entry to find the block start
          const { logs } = await loadBetween(
            container,
            params,
            new Date(firstEntry.date.getTime() - 1000 * 60 * 10), // 10 minutes before
            firstEntry.date,
            {
              min: 200,
              lastSeenId: firstEntry.id,
            }
          );

          if (logs.length > 0) {
            // Insert the new logs at the beginning (after the loader if it exists)
            const hasLoader = messages.value[0] instanceof LoadMoreLogEntry;
            const insertIndex = hasLoader ? 1 : 0;
            const beforeLoader = messages.value.slice(0, insertIndex);
            const afterLoader = messages.value.slice(insertIndex);
            messages.value = [...beforeLoader, ...logs, ...afterLoader];

            // Recursively try to hide the complete block again
            await hideCompleteLogBlock(logId, targetEntry);
            return;
          }
        } catch (error) {
          console.error('Failed to load more logs for complete block hiding:', error);
        } finally {
          loadingMore.value = false;
        }
      }
    }

    // 将整个块的ID添加到隐藏列表中，而不是从messages数组中删除
    blockIds.forEach(id => hiddenLogIds.value.add(id));
  }

  // 创建过滤后的消息计算属性，排除隐藏的日志
  const visibleMessages = computed(() => {
    return messages.value.filter(message => !hiddenLogIds.value.has(message.id));
  });

  async function getCompleteLogBlock(logId: number): Promise<SimpleLogEntry[]> {
    const targetEntry = messages.value.find(message => message.id === logId);
    if (!targetEntry || !(targetEntry instanceof SimpleLogEntry) || !targetEntry.position) {
      return [];
    }

    const targetIndex = messages.value.findIndex(message => message.id === logId);
    const blockEntries: SimpleLogEntry[] = [];
    let foundStart = false;

    // Find the start of the block by going backwards
    let startIndex = targetIndex;
    while (startIndex >= 0) {
      const entry = messages.value[startIndex];
      if (entry instanceof SimpleLogEntry &&
          entry.containerID === targetEntry.containerID &&
          entry.position) {
        blockEntries.unshift(entry);
        if (entry.position === 'start') {
          foundStart = true;
          break;
        }
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
        blockEntries.push(entry);
        if (entry.position === 'end') break;
        endIndex++;
      } else {
        break;
      }
    }

    // If we haven't found the start of the block, we need to load more logs
    if (!foundStart && startIndex >= 0) {
      const firstEntry = messages.value[startIndex + 1];
      if (firstEntry && firstEntry instanceof SimpleLogEntry) {
        try {
          loadingMore.value = true;
          // Load more logs before the first entry to find the block start
          const { logs } = await loadBetween(
            container,
            params,
            new Date(firstEntry.date.getTime() - 1000 * 60 * 10), // 10 minutes before
            firstEntry.date,
            {
              min: 200,
              lastSeenId: firstEntry.id,
            }
          );

          if (logs.length > 0) {
            // Insert the new logs at the beginning (after the loader if it exists)
            const hasLoader = messages.value[0] instanceof LoadMoreLogEntry;
            const insertIndex = hasLoader ? 1 : 0;
            const beforeLoader = messages.value.slice(0, insertIndex);
            const afterLoader = messages.value.slice(insertIndex);
            messages.value = [...beforeLoader, ...logs, ...afterLoader];

            // Recursively try to get the complete block again
            return await getCompleteLogBlock(logId);
          }
        } catch (error) {
          console.error('Failed to load more logs for complete block:', error);
        } finally {
          loadingMore.value = false;
        }
      }
    }

    return blockEntries;
  }

  return {
    messages: visibleMessages,
    opened,
    error,
    loading,
    hideLogEntry,
    getCompleteLogBlock,
  };
}
