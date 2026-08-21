import { isDestructive } from './destructive.ts';
import { DESTINATIONS, DESTINATION_LABELS, navigate } from './router.ts';

// The command palette registry.
//
// Navigation and safe, reversible actions only. Nothing that publishes,
// approves, deletes, rejects or stores a credential may appear here — see
// destructive.ts for why. `registerCommand` refuses such an id at runtime and a
// test asserts the built registry is disjoint from the destructive set.

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

export class PaletteRegistry {
  readonly #commands = new Map<string, Command>();

  register(command: Command): void {
    if (isDestructive(command.id)) {
      // Fail loudly rather than silently dropping it: a destructive command
      // reaching this call is a design mistake, not a runtime condition.
      throw new Error(
        `refusing to put destructive action '${command.id}' in the command palette; ` +
          'irreversible actions are reachable only from their own detail view',
      );
    }
    this.#commands.set(command.id, command);
  }

  list(): Command[] {
    return [...this.#commands.values()];
  }

  search(query: string): Command[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return this.list();
    return this.list().filter((command) => command.label.toLowerCase().includes(needle));
  }
}

export function createPalette(): PaletteRegistry {
  const palette = new PaletteRegistry();
  for (const destination of DESTINATIONS) {
    palette.register({
      id: `goto.${destination}`,
      label: `Go to ${DESTINATION_LABELS[destination]}`,
      hint: 'Navigate',
      run: () => navigate({ destination }),
    });
  }
  palette.register({
    id: 'theme.toggle',
    label: 'Toggle light / dark theme',
    hint: 'Appearance',
    run: () => {
      const root = document.documentElement;
      const next = root.dataset['theme'] === 'light' ? 'dark' : 'light';
      root.dataset['theme'] = next;
      try {
        localStorage.setItem('linkedin_mcp.theme', next);
      } catch {
        // Non-persistent is acceptable; the theme still applies.
      }
    },
  });
  return palette;
}
