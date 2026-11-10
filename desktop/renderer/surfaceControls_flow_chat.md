# Shared console and download rendering

```text
+--------------------+     +------------------------+
| Main process data  | --> | Clone-safe IPC events  |
+--------------------+     +------------+-----------+
                                       v
                          +------------------------+
                          | Shared renderer helper |
                          | Fields use textContent |
                          +---------+--------------+
                                    v
                          +------------------------+
                          | Console filters or     |
                          | Downloads open/reveal  |
                          +------------------------+
```

```mermaid
graph TD
 A[Real console or download event] --> B[Main sends bounded snapshot]
 B --> C[Renderer receives data]
 C --> D{Console or downloads?}
 D -->|Console| E[Filter by actual level and kind]
 E --> F[Show time source tab URL line message and request metadata]
 D -->|Downloads| G[Show real bytes state and progress]
 G --> H[Existing Open or Show in folder IPC]
 F --> I[No HTML execution from log text]
 G --> I
```
