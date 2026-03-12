---
"nestjs-doctor": patch
---

Add endpoint dependency graph to the report. Each HTTP endpoint now shows which services, repositories, and other providers it calls, including nested dependencies and call order. The new Endpoints tab is hidden until endpoint data is available and is marked as beta.
