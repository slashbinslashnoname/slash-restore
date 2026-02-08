/**
 * SignatureScanner - Aho-Corasick multi-pattern matcher for file signature detection.
 *
 * Scans raw disk buffers in O(n + m) time where n = buffer length and m = total
 * pattern length. This is critical for deep-scan performance: we process every byte
 * of the device exactly once regardless of how many signatures we are searching for.
 */

export interface SignatureMatch {
  /** The file type label (e.g. 'jpeg', 'mp4'). */
  type: string
  /** Absolute byte offset on the device where the file header starts. */
  offset: bigint
  /** The headerOffset from the FileSignature (bytes before the magic where the file actually begins). */
  headerOffset: number
}

interface AhoNode {
  /** Transitions keyed by byte value (0-255). */
  children: Map<number, AhoNode>
  /** Failure link - longest proper suffix that is also a prefix of some pattern. */
  fail: AhoNode | null
  /** Output list - patterns that end at this node. */
  output: Array<{ label: string; patternLength: number; headerOffset: number }>
  /** Depth in the trie (equals number of characters matched so far). */
  depth: number
}

export class SignatureScanner {
  private root: AhoNode
  private built = false

  constructor() {
    this.root = this.createNode(0)
  }

  /**
   * Add a pattern to the scanner.
   *
   * @param pattern - The magic byte sequence to search for.
   * @param label - A label identifying the file type (e.g. 'jpeg').
   * @param headerOffset - How many bytes before the pattern the actual file starts.
   *   For example, MP4's "ftyp" pattern appears 4 bytes into the file, so headerOffset = 4.
   */
  addPattern(pattern: Buffer, label: string, headerOffset: number = 0): void {
    if (this.built) {
      throw new Error('Cannot add patterns after build() has been called')
    }
    if (pattern.length === 0) {
      return
    }

    let current = this.root

    for (let i = 0; i < pattern.length; i++) {
      const byte = pattern[i]
      let child = current.children.get(byte)
      if (!child) {
        child = this.createNode(current.depth + 1)
        current.children.set(byte, child)
      }
      current = child
    }

    current.output.push({
      label,
      patternLength: pattern.length,
      headerOffset
    })
  }

  /**
   * Build failure links using BFS. Must be called after all patterns have been
   * added and before calling scan().
   */
  build(): void {
    const queue: AhoNode[] = []

    // All depth-1 nodes fail back to root.
    for (const child of this.root.children.values()) {
      child.fail = this.root
      queue.push(child)
    }

    // BFS to build failure links for deeper nodes.
    while (queue.length > 0) {
      const current = queue.shift()!

      for (const [byte, child] of current.children) {
        queue.push(child)

        // Walk up the failure chain to find the longest proper suffix
        // that is also a prefix of some pattern.
        let failNode = current.fail
        while (failNode !== null && !failNode.children.has(byte)) {
          failNode = failNode.fail
        }

        child.fail = failNode ? failNode.children.get(byte)! : this.root

        // If the fail target is the child itself, point to root to avoid loop.
        if (child.fail === child) {
          child.fail = this.root
        }

        // Merge output from the failure chain (suffix links / dictionary links).
        if (child.fail.output.length > 0) {
          child.output = child.output.concat(child.fail.output)
        }
      }
    }

    this.built = true
  }

  /**
   * Scan a buffer for all registered patterns.
   *
   * @param buffer - The raw bytes to scan.
   * @param baseOffset - The absolute device offset corresponding to buffer[0].
   *   Used to compute the absolute offset of each match.
   * @param maxMatches - Optional limit on the number of matches returned.
   *   When reached, scanning stops early to avoid unbounded memory growth.
   * @returns Array of matches found, sorted by offset.
   */
  scan(buffer: Buffer, baseOffset: bigint, maxMatches: number = 0): SignatureMatch[] {
    if (!this.built) {
      throw new Error('Must call build() before scan()')
    }

    const matches: SignatureMatch[] = []
    let current = this.root

    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i]

      // Follow failure links until we find a node with a transition for this byte,
      // or we reach the root.
      while (current !== this.root && !current.children.has(byte)) {
        current = current.fail!
      }

      const next = current.children.get(byte)
      current = next ?? this.root

      // Check for pattern matches at the current node.
      if (current.output.length > 0) {
        for (const entry of current.output) {
          // Position where the pattern match ends is `i`.
          // Position where the pattern starts in the buffer is `i - patternLength + 1`.
          // The actual file header starts `headerOffset` bytes before the pattern.
          const patternStartInBuffer = i - entry.patternLength + 1
          const fileStartInBuffer = patternStartInBuffer - entry.headerOffset

          // Only emit if the file start is within or before the buffer.
          // If the file start is before the buffer (negative), we still report it
          // because the carving engine may need this for boundary handling.
          const absoluteFileOffset =
            baseOffset + BigInt(fileStartInBuffer)

          // Sanity check: skip if the computed file offset is negative
          // (would mean corrupted data or overlap artifact).
          if (absoluteFileOffset < 0n) {
            continue
          }

          matches.push({
            type: entry.label,
            offset: absoluteFileOffset,
            headerOffset: entry.headerOffset
          })

          if (maxMatches > 0 && matches.length >= maxMatches) {
            return matches
          }
        }
      }
    }

    // Sort by offset for deterministic output.
    matches.sort((a, b) => {
      if (a.offset < b.offset) return -1
      if (a.offset > b.offset) return 1
      return 0
    })

    return matches
  }

  private createNode(depth: number): AhoNode {
    return {
      children: new Map(),
      fail: null,
      output: [],
      depth
    }
  }
}
