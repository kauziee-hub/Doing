// Existing launchers and test integrations can keep their old environment overrides.
// Doing names take precedence when both are supplied.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("HIRORA_")) {
    const current = `DOING_${key.slice(7)}`;
    if (process.env[current] === undefined) process.env[current] = value;
  }
}
