/** Rectangle stored in a {@link QuadTree}. */
export interface QuadTreeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface QuadTreeEntry<T> {
  readonly bounds: QuadTreeBounds;
  readonly item: T;
}

/**
 * Static broad-phase index for world chunks, occluders and decorations.
 * Dynamic actors use {@link SpatialHashGrid}; this tree is deliberately tuned
 * for data that is rebuilt only when a streamed chunk enters or leaves.
 */
export class QuadTree<T> {
  private readonly entries: QuadTreeEntry<T>[] = [];
  private children: [QuadTree<T>, QuadTree<T>, QuadTree<T>, QuadTree<T>] | null = null;

  constructor(
    private readonly bounds: QuadTreeBounds,
    private readonly capacity = 12,
    private readonly depth = 0,
    private readonly maxDepth = 7,
  ) {}

  public insert(bounds: QuadTreeBounds, item: T): boolean {
    if (!intersects(this.bounds, bounds)) return false;

    if (this.children) {
      const child = this.childContaining(bounds);
      if (child) return child.insert(bounds, item);
    }

    this.entries.push({ bounds, item });
    if (this.entries.length > this.capacity && this.depth < this.maxDepth) this.split();
    return true;
  }

  public query(area: QuadTreeBounds, visitor: (item: T) => void): void {
    if (!intersects(this.bounds, area)) return;
    for (const entry of this.entries) {
      if (intersects(entry.bounds, area)) visitor(entry.item);
    }
    if (this.children) {
      for (const child of this.children) child.query(area, visitor);
    }
  }

  public clear(): void {
    this.entries.length = 0;
    if (this.children) {
      for (const child of this.children) child.clear();
      this.children = null;
    }
  }

  private split(): void {
    if (this.children) return;
    const halfWidth = this.bounds.width / 2;
    const halfHeight = this.bounds.height / 2;
    const x = this.bounds.x;
    const y = this.bounds.y;
    this.children = [
      new QuadTree(
        { x, y, width: halfWidth, height: halfHeight },
        this.capacity,
        this.depth + 1,
        this.maxDepth,
      ),
      new QuadTree(
        { x: x + halfWidth, y, width: halfWidth, height: halfHeight },
        this.capacity,
        this.depth + 1,
        this.maxDepth,
      ),
      new QuadTree(
        { x, y: y + halfHeight, width: halfWidth, height: halfHeight },
        this.capacity,
        this.depth + 1,
        this.maxDepth,
      ),
      new QuadTree(
        { x: x + halfWidth, y: y + halfHeight, width: halfWidth, height: halfHeight },
        this.capacity,
        this.depth + 1,
        this.maxDepth,
      ),
    ];

    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index];
      if (!entry) continue;
      const child = this.childContaining(entry.bounds);
      if (!child) continue;
      child.insert(entry.bounds, entry.item);
      this.entries.splice(index, 1);
    }
  }

  private childContaining(bounds: QuadTreeBounds): QuadTree<T> | null {
    if (!this.children) return null;
    for (const child of this.children) {
      if (contains(child.bounds, bounds)) return child;
    }
    return null;
  }
}

function intersects(a: QuadTreeBounds, b: QuadTreeBounds): boolean {
  return !(
    b.x > a.x + a.width ||
    b.x + b.width < a.x ||
    b.y > a.y + a.height ||
    b.y + b.height < a.y
  );
}

function contains(outer: QuadTreeBounds, inner: QuadTreeBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
