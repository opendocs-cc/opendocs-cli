# Security

Please report vulnerabilities privately to hello@opendocs.cc, or through
GitHub's **Report a vulnerability** button on this repository. Don't open a
public issue for a security problem.

Include what you found, how to reproduce it and the CLI version
(`opendocs --version`). We'll reply as soon as we can and keep you posted
until it's fixed.

The CLI stores your API key in `~/.config/opendocs/config.json` (under
`$XDG_CONFIG_HOME` if set) and only sends it to the API it's configured to
use, `https://api.opendocs.cc` by default.
