<template>
  <aside>
    <header class="flex items-center gap-4">
      <h1 class="mobile-hidden text-2xl">{{ container.name }}</h1>
      <h2 class="text-sm"><DistanceTime :date="container.created" /></h2>
    </header>

    <div class="mt-8 flex flex-col gap-2">
      <section>
        <label class="form-control">
          <textarea
            v-model="query"
            class="textarea textarea-primary w-full font-mono text-lg"
            :class="{ 'textarea-error': error }"
          ></textarea>
          <div class="label">
            <span class="label-text-alt text-error" v-if="error">{{ error }}</span>
            <span class="label-text-alt" v-else>Total {{ results.numRows }} records</span>
          </div>
        </label>
      </section>
      <table class="table table-zebra table-pin-rows table-md" v-if="!evaluating">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in page" :key="row">
            <td v-for="column in columns" :key="column">{{ row[column] }}</td>
          </tr>
        </tbody>
      </table>
      <table class="table table-md animate-pulse" v-else>
        <thead>
          <tr>
            <th v-for="_ in 3">
              <div class="h-4 w-20 animate-pulse bg-base-content/50 opacity-50"></div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="_ in 9">
            <td v-for="_ in 3">
              <div class="h-4 w-20 bg-base-content/50 opacity-20"></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { Container } from "@/models/Container";
const { container } = defineProps<{ container: Container }>();
const query = ref("SELECT * FROM logs");
const error = ref<string | null>(null);
const debouncedQuery = debouncedRef(query, 500);
const evaluating = ref(false);

const url = withBase(
  `/api/hosts/${container.host}/containers/${container.id}/logs?stdout=1&stderr=1&everything&jsonOnly`,
);

const [{ useDuckDB }, response] = await Promise.all([import(`@/composable/duckdb`), fetch(url)]);

if (!response.ok) {
  console.log("error fetching logs from", url);
  throw new Error(`Failed to fetch logs: ${response.statusText}`);
}

const { db, conn } = await useDuckDB();

await db.registerFileBuffer("logs.json", new Uint8Array(await response.arrayBuffer()));

await conn.query(`CREATE TABLE logs AS SELECT unnest(m) FROM 'logs.json'`);

const empty = await conn.query<Record<string, any>>(`SELECT * FROM logs LIMIT 0`);

const results = computedAsync(async () => await conn.query<Record<string, any>>(debouncedQuery.value), empty, {
  onError: (e) => {
    if (e instanceof Error) {
      error.value = e.message;
    }
  },
  evaluating,
});

whenever(evaluating, () => {
  error.value = null;
});

const columns = computed(() =>
  results.value.numRows > 0 ? Object.keys(results.value.get(0) as Record<string, any>) : [],
);
const page = computed(() => (results.value.numRows > 0 ? results.value.slice(0, 20) : []));
</script>
<style lang="postcss" scoped></style>
