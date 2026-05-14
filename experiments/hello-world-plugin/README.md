# Hello World Claude Plugin Experiment

Purpose: minimal, working plugin fixture for HOK-1668 to validate Claude Code manifest and `--plugin-dir` loading behavior.

## File tree

```text
experiments/hello-world-plugin/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── hello.md
└── README.md
```

## Load command

```bash
claude --plugin-dir ./experiments/hello-world-plugin
```

## Invoke command

```bash
/wavemill-hello-world:hello
/wavemill-hello-world:hello Ada
```

## Verification CLI version

`2.1.141 (Claude Code)`

## Observed result

Non-interactive verification in this spike:

```bash
claude --plugin-dir ./experiments/hello-world-plugin -p "/wavemill-hello-world:hello"
# Hello from wavemill-hello-world

claude --plugin-dir ./experiments/hello-world-plugin -p "/wavemill-hello-world:hello Ada"
# Hello from wavemill-hello-world, Ada
```

## Namespacing note

The slash command is plugin-namespaced using manifest `name`:

- manifest name: `wavemill-hello-world`
- command file: `commands/hello.md`
- command id: `/wavemill-hello-world:hello`
