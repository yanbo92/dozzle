// Simulated empty data response to disable actual API call
const releases = { value: [] };

const hasUpdate = computed(() => false);  // No update available since no data is fetched

const latest = computed(() => undefined);  // No latest release information

export function useReleases() {
  return {
    hasUpdate,
    latest,
    releases,
  };
}
