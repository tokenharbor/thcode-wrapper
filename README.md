# thcode

Token Harbor's coding agent. Wraps [opencode](https://github.com/anomalyco/opencode) with one default: every request routes through `https://tokenharbor.ai/v1`, so you pay one bill, share one balance with your `/chat` and your API calls, and benefit from TH's smart-router across Qwen / DeepSeek / Kimi / GLM.

## Install

```sh
npm i -g thcode
```

First run downloads `opencode` if it isn't already installed, and asks for your `thk_live_…` key (free $5 trial available at <https://tokenharbor.ai/dashboard>).

## Use

```sh
cd your-project
thcode
```

Same UX as `opencode` — full agent, plan mode, the lot. Difference: model defaults to `tokenharbor/tokenharbor-smart-thinking`, key is your TH wallet, all charges show up on <https://tokenharbor.ai/dashboard/usage>.

Override the model at any time:

```sh
thcode --model alibaba/qwen3-max
```

Re-enter your key:

```sh
thcode reset
```

## What thcode writes

- `~/.local/share/opencode/auth.json` — gets a `tokenharbor` entry with your key (mode `600`)
- `~/.config/opencode/opencode.jsonc` — gets a `provider.tokenharbor` block pointing at `tokenharbor.ai/v1`

That's all the customisation. The rest of opencode runs unchanged, so every upstream improvement reaches you immediately.

## License

MIT. Same as opencode upstream.
