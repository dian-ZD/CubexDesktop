/** 思维导图式树状布局：根（无上游）在左，分支向右展开；叶子按序排布，父节点纵向居中于子节点。
 * 供主进程（AI 生成工作流落位）与渲染层（自动排版按钮）共用，保证两处排版一致。 */
export const LAYOUT_NODE_W = 220
export const LAYOUT_NODE_H = 92
export const LAYOUT_GAP_X = 110
export const LAYOUT_GAP_Y = 46
export const LAYOUT_CANVAS_W = 2400
export const LAYOUT_CANVAS_H = 1600

export function mindMapLayout<T extends { id: string }>(nodes: T[], edges: Array<{ from: string; to: string }>, existing?: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((node) => node.id))
  const validEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
  const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]))
  const children = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  for (const edge of validEdges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to])
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from])
  }
  // 深度 = 从任一根出发的最长路径（有环/孤岛时兜底为 0）
  const depth = new Map<string, number>()
  const roots = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id)
  const stack = roots.map((id) => ({ id, d: 0 }))
  const seen = new Set<string>()
  while (stack.length) {
    const { id, d } = stack.pop()!
    if ((depth.get(id) ?? -1) >= d) continue
    depth.set(id, d)
    if (seen.has(id)) continue
    seen.add(id)
    for (const child of children.get(id) ?? []) stack.push({ id: child, d: d + 1 })
  }
  // 无根可达的节点（环）视为独立根
  for (const node of nodes) if (!depth.has(node.id)) { depth.set(node.id, 0); roots.push(node.id) }
  // DFS 分配行序：叶子依次占一行，父节点取子节点中位（思维导图的 tidy tree）
  const order = new Map<string, number>()
  let row = 0
  const visit = (id: string, path: Set<string>): void => {
    if (path.has(id)) return
    path.add(id)
    const kids = (children.get(id) ?? []).filter((child) => depth.get(child) === (depth.get(id) ?? 0) + 1)
    if (kids.length === 0) {
      order.set(id, row++)
    } else {
      for (const child of kids) visit(child, path)
      const ys = kids.map((child) => order.get(child) ?? 0)
      order.set(id, (Math.min(...ys) + Math.max(...ys)) / 2)
    }
    path.delete(id)
  }
  for (const root of roots) visit(root, new Set())
  for (const node of nodes) if (!order.has(node.id)) order.set(node.id, row++)
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0
    const x = 80 + column * (LAYOUT_NODE_W + LAYOUT_GAP_X)
    const previous = existing?.get(node.id)
    // 已有有效位置且与其它节点不重叠时保留用户手拖的位置；否则用树状布局
    const keep = previous && previous.x >= 0 && previous.y >= 0 && previous.x <= LAYOUT_CANVAS_W - LAYOUT_NODE_W
    positions.set(node.id, keep ? { ...previous! } : {
      x: Math.round(Math.min(x, LAYOUT_CANVAS_W - LAYOUT_NODE_W)),
      y: Math.round(Math.min(Math.max(80 + order.get(node.id)! * (LAYOUT_NODE_H + LAYOUT_GAP_Y), 40), LAYOUT_CANVAS_H - LAYOUT_NODE_H)),
    })
  }
  return positions
}
