import * as vscode from 'vscode';

/** A suggested name, with the reason it is funny or apt. */
interface BearName {
  name: string;
  note: string;
}

interface NameGroup {
  heading: string;
  names: BearName[];
}

/**
 * Suggestions offered by `Iceberg: Name the Bear`.
 *
 * The setting is free text and always will be — this is a shortcut, not a
 * whitelist. Grouped because the three registers are genuinely different
 * moods: keep the arctic ones for atmosphere, the burn puns to make the point,
 * the soft ones if the guilt is getting too much.
 */
export const BEAR_NAMES: NameGroup[] = [
  {
    heading: 'Arctic',
    names: [
      { name: 'Nanuq', note: 'Inuit for "polar bear" — the default' },
      { name: 'Nanook', note: 'the same name, as spelled in Nanook of the North' },
      { name: 'Siku', note: 'Inuktitut for "sea ice" — the thing that is disappearing' },
      { name: 'Isbjørn', note: 'Norwegian, literally "ice bear"' },
      { name: 'Knut', note: 'after the Berlin Zoo polar bear' },
      { name: 'Ursa', note: 'Ursus maritimus — the polar bear, formally' },
      { name: 'Boreal', note: 'of the north' },
      { name: 'Aurora', note: 'the lights overhead while the ice is still healthy' }
    ]
  },
  {
    heading: 'Burn rate',
    names: [
      { name: 'Frostbyte', note: 'frost, and the unit you are spending' },
      { name: 'Burnie', note: 'names the problem directly' },
      { name: 'Calvin', note: 'calving — what a glacier does when it sheds a chunk' },
      { name: 'Kelvin', note: 'measured in degrees, going the wrong way' },
      { name: 'Sublime', note: 'sublimation: ice to vapour, skipping the puddle' },
      { name: 'Overflow', note: 'for when the budget is a suggestion' },
      { name: 'Cache', note: 'the tokens you would not have burned twice' },
      { name: 'Slush', note: 'the stage after ice and before nothing' },
      { name: 'Floe', note: 'all that is left at the end' },
      { name: 'Ember', note: 'the colour the sky turns below 40%' }
    ]
  },
  {
    heading: 'Soft',
    names: [
      { name: 'Teddy', note: 'the obvious one, and none the worse for it' },
      { name: 'Pudge', note: 'optimistic about the ice supply' },
      { name: 'Biscuit', note: 'no arctic significance whatsoever' },
      { name: 'Winston', note: 'a bear who has seen some budgets' },
      { name: 'Bjørn', note: 'Norwegian for bear, and a perfectly good name' },
      { name: 'Mr Floof', note: 'if the guilt is getting too much' }
    ]
  }
];

const CUSTOM = Symbol('custom');

type Pick = vscode.QuickPickItem & { value?: string | typeof CUSTOM };

/**
 * Prompts for a new bear name and writes it to settings.
 *
 * Exported separately from the command registration so the name list can be
 * checked without a VS Code host.
 */
export async function pickBearName(current: string): Promise<void> {
  const items: Pick[] = [];

  for (const group of BEAR_NAMES) {
    items.push({ label: group.heading, kind: vscode.QuickPickItemKind.Separator });
    for (const { name, note } of group.names) {
      items.push({
        label: name,
        description: name === current ? `${note}  ·  current` : note,
        value: name,
        picked: name === current
      });
    }
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(edit) Something else…',
    description: 'type your own',
    value: CUSTOM
  });

  const chosen = await vscode.window.showQuickPick(items, {
    title: 'Name the bear',
    placeHolder: `Currently ${current}`,
    matchOnDescription: true
  });

  if (!chosen?.value) {
    return;
  }

  let name: string;
  if (chosen.value === CUSTOM) {
    const typed = await vscode.window.showInputBox({
      title: 'Name the bear',
      value: current,
      prompt: 'What should the bear be called?',
      validateInput: (v) => (v.trim().length > 24 ? 'Keep it under 25 characters' : undefined)
    });
    if (typed === undefined) {
      return;
    }
    name = typed.trim();
  } else {
    name = chosen.value;
  }

  if (!name || name === current) {
    return;
  }

  await vscode.workspace
    .getConfiguration('iceberg')
    .update('bearName', name, vscode.ConfigurationTarget.Global);

  void vscode.window.showInformationMessage(`The bear is called ${name} now. 🐻‍❄️`);
}
