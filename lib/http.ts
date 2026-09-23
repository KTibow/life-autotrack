/** Small concurrency + pacing helpers shared by API clients. */

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** concurrency-limited map, keeps input order */
export const pool = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
};

/** sliding-window limiter: at most `limit` starts per `windowMs` */
export const rateLimiter = (limit: number, windowMs: number) => {
	const starts: number[] = [];
	return async () => {
		while (true) {
			const now = Date.now();
			while (starts.length && now - starts[0] >= windowMs) starts.shift();
			if (starts.length < limit) {
				starts.push(now);
				return;
			}
			await sleep(windowMs - (now - starts[0]) + 20);
		}
	};
};
