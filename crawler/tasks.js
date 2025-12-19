// Task Manager for Crawl Task Interface

export function createCrawlTask(keyword, priority = 1, type = "aliexpress_search") {
    // Unique Task ID (e.g., crawl-timestamp-random)
    const taskId = `crawl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    return {
        task_id: taskId,
        task_type: type,
        keyword: keyword,
        max_products: 10,
        priority: priority,
        constraints: {
            no_scroll: true,
            no_pagination: true,
            no_reviews: true,
            stop_on_captcha: true,
            delay_seconds: [3, 5]
        },
        requested_fields: {
            listing: [
                "listing_title", "product_url", "store_name", "has_choice_badge",
                "rating", "review_count", "sold_count"
            ],
            variant: [
                "variant_label", "price", "currency", "stock_available"
            ]
        },
        callback: {
            // In prod this would be env variable e.g. "https://api.bom-pricer.com/api/crawl/result"
            // For now, we assume the crawler knows where to call back or we construct it dynamically
            url: "/api/crawl/result",
            method: "POST",
            auth: {
                type: "HMAC",
                key_id: "crawler-01"
            }
        }
    };
}

export async function dispatchTask(taskPayload, crawlerUrl, apiKey) {
    // In production, this would generic fetch() to external crawler service
    // For now, we simulate dispatch by logging
    console.log(`[DISPATCH] Sending Task ${taskPayload.task_id} to Crawler:`, JSON.stringify(taskPayload, null, 2));

    // Simulate API call success
    // await fetch(crawlerUrl, { method: 'POST', body: JSON.stringify(taskPayload), headers: { 'X-API-KEY': apiKey } });

    return { status: "sent", dispatched_at: Date.now() };
}
