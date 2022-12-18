# Lifinity Flare Sales bot

Simple JS app that fetches Lifinity Flares sales info from hyperspace.xyz and posts them on twitter.
You can change it to fetch other project data by entering a different projectId in settings.yaml.

As for running the bot, you can eiher just `node bot.js` or use the `salesbot.service` with `systemd` to run it as a service on a Unix machine.

### Links

[hyperspace.xyz API reference](https://docs.hyperspace.xyz/hype/developer-guide/overview)
[Twitter Development Platform](https://developer.twitter.com/en)
[Twitter node.js package](https://github.com/PLhery/node-twitter-api-v2)