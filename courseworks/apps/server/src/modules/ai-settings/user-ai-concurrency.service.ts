import { config } from "../../config/index.js";

export class AiConcurrencyLimitError extends Error {
  readonly status = 429;

  constructor(limit: number) {
    super(`当前已有 ${limit} 个 AI 请求正在运行，请等待完成后再试。`);
    this.name = "AiConcurrencyLimitError";
  }
}

export class UserAiConcurrencyLimiter {
  private readonly activeByUser = new Map<string, number>();

  constructor(private readonly limit: number) {}

  acquire(userId: string) {
    const active = this.activeByUser.get(userId) ?? 0;
    if (active >= this.limit) throw new AiConcurrencyLimitError(this.limit);
    this.activeByUser.set(userId, active + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.activeByUser.get(userId) ?? 1) - 1;
      if (remaining > 0) this.activeByUser.set(userId, remaining);
      else this.activeByUser.delete(userId);
    };
  }

  active(userId: string) {
    return this.activeByUser.get(userId) ?? 0;
  }

  async run<T>(userId: string, request: () => Promise<T>) {
    const release = this.acquire(userId);
    try {
      return await request();
    } finally {
      release();
    }
  }

  async stream<T>(userId: string, request: () => Promise<AsyncIterable<T>>) {
    const release = this.acquire(userId);
    try {
      const stream = await request();
      return (async function* () {
        try {
          for await (const item of stream) yield item;
        } finally {
          release();
        }
      })();
    } catch (error) {
      release();
      throw error;
    }
  }
}

const limiter = new UserAiConcurrencyLimiter(config.AI_MAX_CONCURRENT_REQUESTS_PER_USER);

export function acquireUserAiRequestSlot(userId: string) {
  return limiter.acquire(userId);
}

export async function withUserAiRequestSlot<T>(userId: string, request: () => Promise<T>) {
  return limiter.run(userId, request);
}

export async function withUserAiStreamSlot<T>(
  userId: string,
  request: () => Promise<AsyncIterable<T>>,
) {
  return limiter.stream(userId, request);
}
