# OpenVibe.Community

Placeholder for the community hub of the OpenVibe network (https://openvibe.community).

The direction for this service is intentionally undecided. For now it is a single static
page (`public/index.html`) served directly by nginx — there is no application process.

## Deploy

```
/opt/openvibe.community/public/index.html    # served by nginx root
```

nginx vhost: `deploy/nginx/openvibe.community.conf` — static root, TLS via the
`openvibe.community` Let's Encrypt wildcard cert.

## Related services

- Identity/SSO: https://openvibe.network (OpenVibers/OpenVibe.Network)
- Streaming: https://openvibe.live (OpenVibers/OpenVibe.Live)
- Tools: https://openvibe.tools (OpenVibers/OpenVibe.Tools)
- Media: https://openvibe.media (OpenVibers/OpenVibe.Media)
- Games: https://openvibe.games (OpenVibers/OpenVibe.Games)
