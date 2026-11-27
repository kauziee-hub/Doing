/** Reasoning is reserved for explicit thinking requests and difficult code/maths on a GPU. */
export function taskEffort(text: string, gpu: boolean): 'fast' | 'deep' {
  return gpu && /\b(?:think (?:carefully|hard|deeply|through)|reason carefully|use thinking|hard problem|debug|algorithm|dynamic programming|time complexity|prove|derivative|integral)\b|\b(?:solve|write|implement|fix)\b[\s\S]{0,100}\b(?:code|coding|function|solution)\b/i.test(text) ? 'deep' : 'fast';
}
