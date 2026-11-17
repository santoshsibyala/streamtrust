export async function ensureFixtureModel(p, until) {
  const selector = p
    .getByRole('button', { name: 'Select a model' })
    .first();
  if (
    (await selector.count()) &&
    !(await selector.innerText()).includes('fixture-model')
  ) {
    await selector.click();
    await p
      .getByRole('option', { name: /^StreamTrust Fixture(?:\s*selected)?$/ })
      .click();
    const model = p.getByRole('option', {
      name: /^fixture-model(?:\s*selected)?$/,
    });
    if (await model.isVisible().catch(() => false)) await model.click();
  }
  // Selected options include a screen-reader "selected" suffix.
  // Confirm asynchronous selection before submitting the scenario prompt.
  await until(
    async () => (await selector.innerText()).includes('fixture-model'),
    'fixture model ready',
  );
}
