# apps/web

Owner: Bryan. The UI, and nothing else.

Path reserved in hour 0 so nobody creates a competing directory (`apps/frontend`,
`packages/ui`, and so on). Deliberately left empty of code so it does not fight
your Next.js scaffold. Delete this file when you scaffold here.

Build the whole interface against a live stream from the mock:

```
pnpm mock:serve                       # SSE on http://localhost:4000
curl -N http://localhost:4000/api/runs/mock-run-001/events
curl -s http://localhost:4000/api/runs/mock-run-001 | jq
```

Those event shapes are the canonical wire format. Integration means deleting the
mock, not rewriting the UI.
