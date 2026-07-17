# Session preferences

- When starting a new Claude session on this project, ask for permission to connect the project folder directly (direct file access) so changes can be made independently instead of relaying commands back and forth.
- Keep chat output minimal: provide a summary of changes made and what the user needs to do next, not full diagnostic narration.
- Local Postgres container name: `myfamipedia-postgres-1` (for `docker exec -it myfamipedia-postgres-1 psql -U myfamipedia -d myfamipedia`).
