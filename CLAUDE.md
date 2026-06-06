# SGLang

High-performance serving framework for large language models and multimodal models. Designed for low-latency, high-throughput inference from single GPU to large distributed clusters.

## Core Features

- RadixAttention for KV cache reuse
- Zero-overhead batch scheduler
- Cache-aware load balancer
- Structured output (JSON, regex) with compressed FSM
- Prefill-decode (PD) disaggregation
- Expert parallelism for MoE models
- TPU/JAX backend support
- Diffusion model support (images + video)

## Project Structure

```
sglang/
├── python/
│   └── sglang/           # Main Python package
│       ├── srt/          # SGLang Runtime (inference engine)
│       │   ├── server.py # Launch server
│       │   ├── managers/ # Request managers, schedulers
│       │   └── models/   # Model implementations
│       └── lang/         # SGLang programming language
├── sgl-kernel/           # Custom CUDA/Triton kernels
├── sgl-model-gateway/    # Model gateway service
├── benchmark/            # Benchmarking scripts
├── examples/             # Usage examples
├── test/                 # Test suite
├── docker/               # Docker configs
├── docs/                 # Documentation
├── scripts/              # CI and utility scripts
└── 3rdparty/             # Third-party dependencies
```

## Installation

```bash
# Install stable release
pip install sglang[all]

# Install from source (development)
pip install -e "python/.[all]"

# Install kernel (optional, improves performance)
pip install sgl-kernel
```

## Quick Start

```bash
# Launch inference server
python -m sglang.launch_server \\
  --model-path meta-llama/Llama-3.1-8B-Instruct \\
  --port 30000

# OpenAI-compatible API (same port)
curl http://localhost:30000/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "meta-llama/Llama-3.1-8B-Instruct", "messages": [...]}'
```

## Development

```bash
# Run tests
cd test && python -m pytest srt/         # runtime tests
cd test && python -m pytest lang/        # language tests

# Format
pip install pre-commit && pre-commit run --all-files

# Build kernels
cd sgl-kernel && pip install -e .
```

## Key Concepts

- **SRT (SGLang Runtime)**: The inference engine (`python/sglang/srt/`). Manages model loading, batching, KV cache, scheduling.
- **RadixAttention**: Token-level KV cache reuse via prefix trees. Reduces redundant computation for shared prompts.
- **Structured Output**: Constrained decoding using compressed FSMs. ~3x faster than naive JSON generation.
- **PD Disaggregation**: Separate prefill and decode workers for heterogeneous GPU fleets.

## Contributing

See `CONTRIBUTING.md`. Key points:
- All new features need tests in `test/`.
- Kernel changes (`sgl-kernel/`) require benchmarks showing no regression.
- Breaking API changes need documentation updates in `docs/`.
- Run `pre-commit` before submitting PRs.
