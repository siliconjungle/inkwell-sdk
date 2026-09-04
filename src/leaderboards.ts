import { requestGameService, type GameServiceRequest } from "./game-services.js";

export type LeaderboardDefinition = {
  name: string;
  communityName?: string | null;
  sort?: "ascending" | "descending";
  display?: "numeric" | "seconds" | "milliseconds";
  serverWritesOnly?: boolean;
  friendsReadsOnly?: boolean;
  enabled?: boolean;
};
export type LeaderboardInfo = Required<LeaderboardDefinition> & {
  createdAt: string;
  updatedAt: string;
};
export type LeaderboardEntry = {
  username: string;
  avatarUrl: string | null;
  score: number;
  details: number[];
  rank: number;
  updatedAt: string;
};
export type LeaderboardResult = {
  board: LeaderboardInfo;
  total: number;
  entries: LeaderboardEntry[];
};
export type ScoreSubmission = {
  score: number;
  details?: number[];
  method?: "keepBest" | "forceUpdate";
};
export type ScoreResult = {
  score: number;
  updated: boolean;
  scoreChanged: boolean;
  previousRank: number | null;
  rank: number;
};
export type LeaderboardQuery = {
  scope?: "global" | "friends" | "around" | "users";
  start?: number;
  limit?: number;
  before?: number;
  after?: number;
  usernames?: string[];
};

function nameOf(name: string) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) throw new TypeError("Invalid leaderboard name.");
  return name;
}
function validateScore(input: ScoreSubmission) {
  const valid = (value: number) =>
    Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  if (
    !valid(input.score) ||
    (input.details !== undefined &&
      (!Array.isArray(input.details) || input.details.length > 64 || !input.details.every(valid)))
  )
    throw new TypeError("Scores and up to 64 details must be signed int32 values.");
  if (input.method !== undefined && !["keepBest", "forceUpdate"].includes(input.method))
    throw new TypeError("Invalid score update method.");
}

export class Leaderboard {
  constructor(
    readonly name: string,
    protected readonly request: GameServiceRequest = requestGameService,
  ) {
    nameOf(name);
  }
  get() {
    return this.request<{ board: LeaderboardInfo }>("leaderboards", {
      operation: "get",
      name: this.name,
    });
  }
  list(query: LeaderboardQuery = {}) {
    return this.request<LeaderboardResult>("leaderboards", {
      operation: "query",
      name: this.name,
      query,
    });
  }
  aroundMe(options: { before?: number; after?: number } = {}) {
    return this.list({ ...options, scope: "around" });
  }
  async getMyEntry() {
    const result = await this.aroundMe({ before: 0, after: 0 });
    return result.entries[0] ?? null;
  }
  submit(input: ScoreSubmission) {
    validateScore(input);
    return this.request<ScoreResult>("leaderboards", {
      ...input,
      operation: "submit",
      name: this.name,
    });
  }
}

export class ServerLeaderboard extends Leaderboard {
  submitFor(username: string, input: ScoreSubmission) {
    validateScore(input);
    return this.request<ScoreResult>("leaderboards", {
      ...input,
      operation: "submit",
      name: this.name,
      username,
    });
  }
  queryFor(username: string, query: LeaderboardQuery = {}) {
    return this.request<LeaderboardResult>("leaderboards", {
      operation: "query",
      name: this.name,
      username,
      query,
    });
  }
  update(definition: Omit<LeaderboardDefinition, "name">) {
    return this.request<{ board: LeaderboardInfo }>("leaderboards", {
      operation: "update",
      name: this.name,
      definition,
    });
  }
  reset() {
    return this.request<{ success: true }>("leaderboards", { operation: "reset", name: this.name });
  }
  deleteEntry(username: string) {
    return this.request<{ success: true }>("leaderboards", {
      operation: "deleteEntry",
      name: this.name,
      username,
    });
  }
  delete() {
    return this.request<{ success: true }>("leaderboards", {
      operation: "delete",
      name: this.name,
    });
  }
}

export function createLeaderboards(request: GameServiceRequest = requestGameService) {
  return Object.freeze({
    board: (name: string) => new Leaderboard(name, request),
    list: (offset = 0) =>
      request<{ boards: LeaderboardInfo[]; nextOffset: number | null }>("leaderboards", {
        operation: "list",
        offset,
      }),
  });
}
export function createServerLeaderboards(request: GameServiceRequest) {
  return Object.freeze({
    ...createLeaderboards(request),
    board: (name: string) => new ServerLeaderboard(name, request),
    define: (definition: LeaderboardDefinition) =>
      request<{ board: LeaderboardInfo }>("leaderboards", {
        operation: "define",
        name: nameOf(definition.name),
        definition,
      }),
  });
}
export const leaderboards = createLeaderboards();
