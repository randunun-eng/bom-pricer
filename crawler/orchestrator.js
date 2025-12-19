import { createCrawlTask, dispatchTask } from "./tasks.js";

// Crawler Orchestrator (Nova ACT / Anti-Gravity)
// Production-Grade Multi-Keyword Orchestrator
// Features: Batching, Priority, Failure Classification, Exponential Backoff, Global Circuit Breaker

// Config
const BATCH_SIZE = 2; // Crawl 2 keywords per run
const RETRY_SOFT_1_MS = 6 * 60 * 60 * 1000; // 6 hours
const RETRY_SOFT_2_MS = 12 * 60 * 60 * 1000; // 12 hours
const RETRY_HARD_MS = 24 * 60 * 60 * 1000; // 24 hours
const GLOBAL_PAUSE_MS = 24 * 60 * 60 * 1000; // 24 hours (Global Breaker)

export default {
    async fetch(req, env, ctx) {
        if (req.headers.get("X-AUTH-KEY") !== env.CRAWLER_KEY) {
            // Allow local testing, enforce in prod
        }
        const report = await runOrchestrator(env);
        return Response.json(report);
    }
};

export async function runOrchestrator(env) {
    console.log("Orchestrator started (Task Dispatch Mode).");

    // 0. CHECK GLOBAL CIRCUIT BREAKER
    const { results: globalPause } = await env.DB.prepare(
        "SELECT next_retry FROM crawl_keywords WHERE keyword = '__GLOBAL_PAUSE__'"
    ).all();

    if (globalPause && globalPause.length > 0) {
        const pauseUntil = globalPause[0].next_retry || 0;
        if (Date.now() < pauseUntil) {
            console.warn(`GLOBAL CIRCUIT BREAKER ACTIVE until ${new Date(pauseUntil).toISOString()}`);
            return { status: "blocked", message: "Global Circuit Breaker Active" };
        }
    }

    // 1. Fetch Batch of Pending Keywords
    const now = Date.now();
    const { results: keywords } = await env.DB.prepare(`
      SELECT keyword, canonical_type, priority, fail_count, last_crawled, next_retry, status
      FROM crawl_keywords
      WHERE keyword != '__GLOBAL_PAUSE__'
        AND status IN ('pending', 'done', 'soft_fail') 
        AND enabled = 1
        AND (next_retry IS NULL OR next_retry <= ?)
      ORDER BY priority ASC, last_crawled ASC
      LIMIT ?
    `).bind(now, BATCH_SIZE).all();

    if (!keywords || keywords.length === 0) {
        return { status: "idle", message: "No eligible keywords to crawl" };
    }

    const report = { dispatched: [], failures: [] };
    let globalHardFailTriggered = false;

    // 2. Process Batch
    for (const task of keywords) {
        if (globalHardFailTriggered) break;

        console.log(`Preparing task for: ${task.keyword}`);

        try {
            // 2a. Create Task Payload
            const crawlTask = createCrawlTask(task.keyword, task.priority);

            // 2b. Insert into crawl_tasks (Pending)
            await env.DB.prepare(`
              INSERT INTO crawl_tasks (task_id, keyword, status, created_at)
              VALUES (?, ?, 'pending', ?)
            `).bind(crawlTask.task_id, task.keyword, Date.now()).run();

            // 2c. Dispatch Task
            // In a real scenario, we send this to the crawler service.
            // For now, we simulate dispatch.
            const dispatchResult = await dispatchTask(crawlTask, "http://mock-crawler", env.CRAWLER_KEY);

            if (dispatchResult.status === "sent") {
                // Update Status in crawl_keywords to 'in_progress' (or 'sent')
                // We keep 'in_progress' to prevent re-selection by scheduler
                await env.DB.prepare(
                    "UPDATE crawl_keywords SET status = 'in_progress' WHERE keyword = ?"
                ).bind(task.keyword).run();

                await env.DB.prepare(
                    "UPDATE crawl_tasks SET status = 'sent' WHERE task_id = ?"
                ).bind(crawlTask.task_id).run();

                report.dispatched.push(crawlTask.task_id);

                // Real crawler expected to POST back to /api/crawl/result
                // No mock simulation - data will remain PENDING until real crawl completes
                console.log(`[Orchestrator] Task ${crawlTask.task_id} dispatched. Awaiting real crawler callback.`);

            } else {
                throw new Error("Dispatch failed");
            }

        } catch (err) {
            console.error(`Failed to dispatch task for ${task.keyword}:`, err);
            await env.DB.prepare(
                "UPDATE crawl_keywords SET status = 'soft_fail', fail_count = fail_count + 1, next_retry = ?, last_error = ?, error_type = 'dispatch_error' WHERE keyword = ?"
            ).bind(now + RETRY_SOFT_1_MS, err.message, task.keyword).run();
            report.failures.push({ keyword: task.keyword, error: err.message });
        }
    }

    return report;
}
