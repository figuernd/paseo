# @getpaseo/connector

A remote MCP bridge that lets Claude — including voice mode — start and steer [Paseo](https://paseo.sh) agents across your machines.

You run one connector. It reaches every Paseo host you configure, over direct TCP or Paseo's encrypted relay, and exposes a single OAuth-protected MCP endpoint for Claude to connect to.

```bash
npx @getpaseo/connector
```

Configuration, setup, and how to add it in Claude: [paseo.sh/docs/claude-connector](https://paseo.sh/docs/claude-connector).

Design notes and the trust boundary: [docs/connector.md](https://github.com/getpaseo/paseo/blob/main/docs/connector.md).

## License

AGPL-3.0-or-later
