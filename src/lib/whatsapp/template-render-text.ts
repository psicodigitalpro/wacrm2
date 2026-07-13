/**
 * Fill a Meta-style template body's `{{1}}`, `{{2}}`, ... placeholders
 * with positional values, producing plain free-form text.
 *
 * uazapi has no template-approval system — sending "a template" there
 * just means sending its rendered body as a normal message. This is
 * the one substitution helper shared by automations' engineSendTemplate
 * and the two broadcast implementations, so the same rendering rule
 * doesn't drift across the three call sites.
 */
export function renderTemplateBodyText(bodyText: string, params?: string[] | null): string {
  if (!params || params.length === 0) return bodyText
  return bodyText.replace(/\{\{(\d+)\}\}/g, (match, indexStr) => {
    const value = params[Number(indexStr) - 1]
    return value !== undefined ? value : match
  })
}
