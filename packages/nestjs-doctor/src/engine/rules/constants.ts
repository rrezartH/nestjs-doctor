/**
 * Class name suffixes for NestJS infrastructure classes (guards, interceptors, etc.)
 * that are typically self-registered or framework-activated and should be excluded
 * from rules that check for explicit provider registration or injection.
 */
export const INFRA_SUFFIXES = [
	"Guard",
	"Interceptor",
	"Filter",
	"Pipe",
	"Middleware",
	"Strategy",
	"Subscriber",
	"Listener",
	"Processor",
	"Consumer",
	"Worker",
	"Scheduler",
	"Cron",
	"HealthIndicator",
];
