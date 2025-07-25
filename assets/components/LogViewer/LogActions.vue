<template>
  <div class="dropdown dropdown-start dropdown-hover absolute -left-2 z-10 font-sans" v-show="container">
    <router-link
      v-if="isSearching"
      @click="resetSearch()"
      tabindex="0"
      class="btn btn-square btn-xs border-base-content/20 bg-base-100 pointer-events-auto! opacity-0 shadow-sm group-hover/entry:opacity-90"
      :to="{
        name: '/container/[id].time.[datetime]',
        params: { id: container.id, datetime: logEntry.date.toISOString() },
        query: { logId: logEntry.id },
      }"
    >
      <material-symbols:eye-tracking />
    </router-link>
    <button
      tabindex="0"
      class="btn btn-square btn-xs border-base-content/20 bg-base-100 border opacity-0 shadow-sm group-hover/entry:opacity-90"
      v-else
    >
      <ion:ellipsis-vertical />
    </button>
    <ul
      tabindex="0"
      class="menu dropdown-content rounded-box bg-base-200 border-base-content/20 z-50 w-52 border p-1 text-sm shadow-sm"
      @click="hideMenu"
    >
      <li v-if="isSearching">
        <router-link
          @click="resetSearch()"
          :to="{
            name: '/container/[id].time.[datetime]',
            params: { id: container.id, datetime: logEntry.date.toISOString() },
            query: { logId: logEntry.id },
          }"
        >
          <material-symbols:eye-tracking />
          {{ $t("action.see-in-context") }}
        </router-link>
      </li>
      <li v-if="isSupported">
        <a @click="copyLogMessage()">
          <material-symbols:content-copy />
          {{ $t("action.copy-log") }}
        </a>
      </li>
      <li v-if="isSupported && logEntry instanceof SimpleLogEntry && logEntry.position">
        <a @click="copyLogBlock()">
          <material-symbols:content-copy />
          {{ $t("action.copy-block") }}
        </a>
      </li>
      <li v-if="isSupported">
        <a @click="copyPermalink()">
          <material-symbols:link />
          {{ $t("action.copy-link") }}
        </a>
      </li>
      <li v-if="logEntry instanceof ComplexLogEntry">
        <a @click="showDrawer(LogDetails, { entry: logEntry })">
          <material-symbols:code-blocks-rounded />
          {{ $t("action.show-details") }}
        </a>
      </li>
      <li class="border-t border-base-content/20 my-1"></li>
      <li>
        <a @click="hideLogEntry()" class="text-warning hover:bg-warning/10" :class="{ 'pointer-events-none': isHiding }">
          <span v-if="isHiding" class="loading loading-spinner loading-xs"></span>
          <material-symbols:visibility-off v-else />
          {{ isHiding ? $t("action.hiding-log") : $t("action.hide-log") }}
        </a>
      </li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
import stripAnsi from "strip-ansi";
import { Container } from "@/models/Container";
import { LogEntry, SimpleLogEntry, ComplexLogEntry, JSONObject } from "@/models/LogEntry";
import LogDetails from "./LogDetails.vue";

const { logEntry, container } = defineProps<{
  logEntry: LogEntry<string | JSONObject>;
  container: Container;
}>();

const { showToast } = useToast();
const showDrawer = useDrawer();
const router = useRouter();
const { isSearching, resetSearch } = useSearchFilter();

const { copy, isSupported, copied } = useClipboard();
const { t } = useI18n();
const isHiding = ref(false);

// Inject hide functionality from parent
const hideLogEntryFn = inject<((logId: number) => Promise<void>) | undefined>('hideLogEntry', undefined);

// Inject messages from parent to access the full log stream
const messages = inject<Ref<LogEntry<string | JSONObject>[]>>('messages', ref([]));

async function copyLogMessage() {
  if (logEntry instanceof ComplexLogEntry) {
    await copy(stripAnsi(logEntry.rawMessage));
  } else if (logEntry instanceof SimpleLogEntry) {
    await copy(stripAnsi(logEntry.rawMessage));
  }

  if (copied.value) {
    showToast(
      {
        title: t("toasts.copied.title"),
        message: t("toasts.copied.message"),
        type: "info",
      },
      { expire: 2000 },
    );
  }
}

async function copyLogBlock() {
  if (!(logEntry instanceof SimpleLogEntry) || !logEntry.position) {
    return;
  }

  const targetIndex = messages.value.findIndex(message => message.id === logEntry.id);
  if (targetIndex === -1) return;

  const blockEntries: SimpleLogEntry[] = [];
  
  // 向后查找块的开始
  let startIndex = targetIndex;
  while (startIndex >= 0) {
    const entry = messages.value[startIndex];
    if (entry instanceof SimpleLogEntry && 
        entry.containerID === logEntry.containerID &&
        entry.position) {
      blockEntries.unshift(entry);
      if (entry.position === 'start') break;
      startIndex--;
    } else {
      break;
    }
  }
  
  // 向前查找块的结束
  let endIndex = targetIndex + 1;
  while (endIndex < messages.value.length) {
    const entry = messages.value[endIndex];
    if (entry instanceof SimpleLogEntry && 
        entry.containerID === logEntry.containerID &&
        entry.position) {
      blockEntries.push(entry);
      if (entry.position === 'end') break;
      endIndex++;
    } else {
      break;
    }
  }

  // 将所有块条目的原始消息连接起来
  const blockContent = blockEntries
    .map(entry => stripAnsi(entry.rawMessage))
    .join('\n');

  await copy(blockContent);

  if (copied.value) {
    showToast(
      {
        title: t("toasts.copied.title"),
        message: t("toasts.copied.block-message"),
        type: "info",
      },
      { expire: 2000 },
    );
  }
}

async function copyPermalink() {
  const url = router.resolve({
    name: "/container/[id].time.[datetime]",
    params: { id: container.id, datetime: logEntry.date.toISOString() },
    query: { logId: logEntry.id },
  }).href;

  const resolved = new URL(url, window.location.origin);

  await copy(resolved.href);

  if (copied.value) {
    showToast(
      {
        title: t("toasts.copied.title"),
        message: t("toasts.copied.message"),
        type: "info",
      },
      { expire: 2000 },
    );
  }
}

async function hideLogEntry() {
  if (hideLogEntryFn && !isHiding.value) {
    try {
      isHiding.value = true;
      await hideLogEntryFn(logEntry.id);
      showToast(
        {
          title: t("toasts.hidden.title"),
          message: t("toasts.hidden.message"),
          type: "success",
        },
        { expire: 2000 },
      );
    } catch (error) {
      console.error('Failed to hide log entry:', error);
      showToast(
        {
          title: t("toasts.error.title"),
          message: t("toasts.error.message"),
          type: "error",
        },
        { expire: 3000 },
      );
    } finally {
      isHiding.value = false;
    }
  }
}

function hideMenu(e: MouseEvent) {
  if (e.target instanceof HTMLAnchorElement) {
    setTimeout(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }, 50);
  }
}
</script>
