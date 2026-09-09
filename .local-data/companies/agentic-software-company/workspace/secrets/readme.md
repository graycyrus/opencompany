# Workspace secrets

Store private operator notes and secret values in this folder. Everything under `secrets/` is hidden from agent workspace tools, including listing, reading, searching, and writing. Operators can still browse and edit these notes in the Workspace view.

Do not treat this folder as an application credential store: use the Connections and inference settings for credentials that OpenCompany must inject into tools or providers.
