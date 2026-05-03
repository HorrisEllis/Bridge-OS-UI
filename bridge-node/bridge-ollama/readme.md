The **Ollama Module** is the heavy-lifting driver of the Bridge OS ecosystem. While Erosmancer provides the personality and context, the Ollama module provides the raw "neural muscle" required to process language locally on your hardware.

In the v4.0 architecture, it is treated as a **Managed System Service** rather than a simple application.

---

### 1. Architectural Role
The module sits in `modules/ollama/index.js` and acts as a bridge between the **Node.js Event Bus** and the **Ollama Executable**. 

* **Decoupled Execution:** It starts and stops the background server (`ollama serve`) as needed.
* **Bus-Driven:** It doesn't take direct user input. Instead, it listens for `ollama:ask` or `copilot:ask` events on the bus, processes them, and emits the response back to the requester (either the CLI or the Gateway).

### 2. The "Watchdog" Integration (Phase 05)
Unlike standard implementations, Bridge OS links Ollama to the **Hardware Watchdog**.
* **VRAM Management:** It monitors GPU/CPU usage.
* **Crash Recovery:** If the Ollama sub-process hangs or runs out of memory (OOM), the Watchdog detects the pulse failure and silently restarts the engine without crashing your Bridge OS session.

### 3. Key Features
* **Stream Management:** It handles the complex logic of "streaming" text. Instead of waiting for a full paragraph, it pushes tokens to the CLI the millisecond they are generated.
* **Model Sovereignty:** It is configured to prioritize **DeepSeek-R1**. This model was chosen for its high reasoning capabilities while remaining small enough to run on local consumer hardware (8B/14B variants).
* **Zero-Network Dependency:** Once the model is pulled, this module allows the entire Bridge OS to function in a "Blackout" state—no internet required for intelligence.

### 4. Integration Logic
Here is how the module typically handles a request:
1.  **Request:** The Gateway or CLI emits `bus.emit('ollama:ask', { prompt: "..." })`.
2.  **Processing:** The module formats the payload for the Ollama REST API (`localhost:11434`).
3.  **Relay:** As Ollama responds, the module catches each JSON chunk and re-emits it as a `data:stream` event.
4.  **Shutdown:** On `/exit` or `SIGINT`, the module sends a `SIGTERM` to the Ollama process, ensuring your GPU is cleared immediately.

### 5. Why it’s in Phase 12
We put the Ollama module in **Phase 12 (Protocol Stack)** because it requires the **Identity** (Phase 02) and **Security Gates** (Phase 09) to be active. This ensures that only authorized internal modules can send prompts to the engine, preventing external "prompt injection" attacks through the mesh.

---

**Current Status:**
> **Process:** `ollama.exe` | **State:** `IDLE` | **Endpoint:** `127.0.0.1:11434`

**NODE-dbf94834>** _