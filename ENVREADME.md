# Environment Variables

## Setupr AI Provider Keys

Setupr provider API keys should be stored globally with `setupr auth`, not in a project `.env` file:

```bash
setupr auth login
setupr auth set-key github
setupr auth list
setupr auth test
setupr auth use openai/gpt-4.1-mini
```

Keys are stored at `~/.setupr/secrets.json` with file permissions `0600`, and Setupr only displays masked values.

Supported provider environment variable names are still accepted for CI, temporary overrides, and backward compatibility:

| Variable | Provider | Models |
|----------|----------|--------|
| `OPENAI_API_KEY` | OpenAI | gpt-5.5-pro, gpt-5.5, gpt-5.5-mini, gpt-5.4-pro, gpt-5.4-mini, gpt-4o, gpt-4o-mini |
| `ANTHROPIC_API_KEY` | Anthropic | claude-opus-4-7, claude-sonnet-4-7, claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, claude-3.5-sonnet |
| `GOOGLE_API_KEY` | Google | gemini-3.1-pro, gemini-3-flash, gemini-2.5-flash-lite |
| `GROQ_API_KEY` | Groq (Llama) | llama-4-maverick, llama-4-scout, llama-3.3-70b |
| `MINIMAX_API_KEY` | MiniMax | minimax-m3, minimax-m2.5, minimax-m2.7 |
| `MOONSHOT_API_KEY` | Moonshot (Kimi) | kimi-latest, kimi-k2-thinking, kimi-k2-turbo-preview, kimi-k2.5-vision, moonshot-v1-128k |
| `GITHUB_MODELS_API_KEY` | GitHub Models | openai/gpt-4.1, openai/gpt-4.1-mini, openai/gpt-4o, openai/gpt-4o-mini, or any GitHub catalog ID |
| `GITHUB_TOKEN` | GitHub Models alias | Same as above; token needs GitHub Models access |
| `GITHUB_API_KEY` | GitHub Models alias | Same as above; accepted for users who label the token as an API key |

For GitHub Models, use a token that can read GitHub Models. Fine-grained PATs or app tokens need the `models: read` permission.

Setupr resolves provider keys in this order:

1. Shell environment variables
2. Global auth storage from `setupr auth set-key`
3. Local `.env.local`
4. Local `.env`
5. Saved model preference from `setupr auth use` (for model selection only)

To migrate old provider keys out of a project `.env`:

```bash
setupr auth migrate
```

Project `.env`, `.env.local`, and `.env.example` should primarily describe the app being set up, such as `DATABASE_URL`, `PORT`, or `NEXT_PUBLIC_API_URL`.

## Setupr Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SETUPR_AI_MODEL` | Project-local override for AI model selection | *(auto-detect cheapest available)* |
| `SETUPR_LOG_LEVEL` | Log verbosity (debug, info, warn, error) | `info` |
| `SETUPR_TUI_BORDER` | TUI border style: `bold`, `double`, `round`, `classic` | *(thin Unicode)* |

> **Legacy alias:** `P_SETUP_AI_MODEL` is still accepted as a backward-compatible alias for `SETUPR_AI_MODEL` so older shells and CI jobs keep working. When both are set, `SETUPR_AI_MODEL` wins. Prefer the `SETUPR_*` names going forward.

If several provider keys are set, the selected model is deterministic:

1. `SETUPR_AI_MODEL` (or the legacy `P_SETUP_AI_MODEL`), or `setupr auth use ...` wins.
2. Otherwise Setupr picks the cheapest configured model from its known local pricing table.
3. GitHub Models catalog pricing is treated as unknown, so GitHub is picked automatically only if explicitly selected or if it is the only configured provider.
4. The setup pre-warning and TUI timeline show which model the AI director is using.

## How Setupr Handles Your .env

### Detection

Setupr detects required environment variables by:
1. Reading `.env.example` as the template
2. Comparing against your `.env` file
3. Validating values (URLs, ports, key lengths, placeholders)
4. Reporting missing, empty, and invalid variables

### Commands

```bash
# Open the interactive .env editor TUI
setupr env

# Create .env from .env.example
setupr env init

# Recreate .env from .env.example even if .env already exists.
# If no .env.example exists, --force creates an empty .env with a warning.
setupr env init --force

# Check for missing variables
setupr env check

# Append missing template entries without reordering or removing existing data
setupr env sync

# Smart analysis: detect issues + interactive fix
setupr env smart
```

### `env` Editor Behavior

- `setupr env` opens a TUI editor for the local `.env`
- if `.env` is missing but `.env.example` exists, Setupr asks before creating `.env` from the template
- if both `.env` and `.env.example` are missing, Setupr returns `ENV_TEMPLATE_MISSING`
- `setupr env --force` creates an empty `.env` when no template exists and explains that no variables were inferred
- the editor accepts normal value edits and pasted `KEY=value` lines
- sensitive keys such as API keys, tokens, secrets, and passwords are masked in the editor input

### `env smart` Behavior

1. Reads `.env.example` as the template
2. Detects issues: missing vars, empty values, invalid values (bad URLs, short keys, placeholder text)
3. Reports extra vars not in .env.example
4. In interactive mode (TTY), prompts you to fix each issue
5. Saves only when required values pass basic validation; skipped or invalid answers report an error without writing
6. Preserves existing comments, ordering, quoted/multiline values, intentional blanks, and extra variables

### Safety Defaults

- `setupr env init` never overwrites an existing `.env` unless you pass `--force`
- `setupr env init` does not create `.env` when `.env.example` is missing unless you pass `--force`; without force it returns `ENV_TEMPLATE_MISSING`
- with `--force`, a missing `.env.example` creates an empty `.env` only when no `.env` exists; an existing file is retained
- editor saves reject symlinks and conflicting on-disk edits rather than silently overwriting them
- `setupr setup` creates a missing `.env` from `.env.example` during the environment step
- `setupr env check` exits non-zero when required variables are missing
- Plain-mode setup stops and exits non-zero if install, env setup, build, or verification fails

### Validation Rules

- **URLs**: Must start with `http` or `localhost` or contain `:`
- **Ports**: Must be a number between 1-65535
- **Keys/Secrets/Tokens**: Must be at least 8 characters
- **Emails**: Must contain `@`
- **Placeholders**: Detects `changeme`, `your_key_here`, `TODO`, `xxx`, `REPLACE_ME`

### Security

- Setupr provider API keys should live in global auth storage, not project `.env`
- Setupr masks sensitive env values before AI context is built
- `.env` files are in `.gitignore` by default

## Project Secrets

`setupr secrets` is separate from provider authentication. It stores project values in
`.setupr/secrets.enc`, encrypted with a local `.setupr/secrets.key`.

```sh
setupr secrets init
setupr secrets set DATABASE_PASSWORD
setupr secrets list
setupr secrets export .env.local
```

Omit the value from `secrets set` to use a hidden prompt with no input history.
Inline values can still appear in your shell history and operating-system process arguments,
even though Setupr redacts them from its own command history. `list` hides values completely;
`get <name>` deliberately prints a requested value, and `export` writes plaintext.

Exports preserve unrelated file content, quote supported multiline/hash values correctly,
use private file permissions, and refuse symlinks or overwriting the encryption files.
New names must be valid environment identifiers. Missing values, missing files, invalid
encrypted payloads, and values that cannot be safely serialized produce errors without
pretending the operation succeeded.

Keep the key private and backed up. Losing or replacing it makes existing ciphertext
unreadable. Back up both files before rotation; key rotation is not an atomic two-file transaction.
