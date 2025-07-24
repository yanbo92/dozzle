type Announcement = {
  name: string;
  announcement: boolean;
  createdAt: Date;
  body: string;
  tag: string;
  htmlUrl: string;
  latest: boolean;
  mentionsCount: number;
  features: number;
  bugFixes: number;
  breaking: number;
};

// {{ AURA-X: Remove - 禁用发布检查以支持无网络环境部署. Approval: 寸止(ID:1678886400). }}
// const { data: releases } = useFetch(withBase("/api/releases")).get().json<Announcement[]>();

const otherAnnouncements = [] as Announcement[];

const announcements = computed(() => {
  // {{ AURA-X: Modify - 移除外部发布数据，仅使用本地公告. Approval: 寸止(ID:1678886400). }}
  return [...otherAnnouncements].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
});

const mostRecent = computed(() => announcements.value?.[0]);
const latestRelease = computed(() => announcements.value?.find((release) => release.latest && !release.announcement));
const hasRelease = computed(() => latestRelease.value !== undefined);

export function useAnnouncements() {
  return {
    mostRecent,
    announcements,
    latestRelease,
    hasRelease,
  };
}
