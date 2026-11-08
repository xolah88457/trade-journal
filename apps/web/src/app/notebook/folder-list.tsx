"use client";

import { useState, type CSSProperties, type KeyboardEventHandler } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface FolderItem {
  id: string;
  name: string;
  kind: string;
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** Puts `folders` in `order`, keeping any folder `order` does not know at the end. */
export const applyFolderOrder = <T extends { id: string }>(
  folders: readonly T[],
  order: readonly string[] | null,
): T[] => {
  if (!order) return [...folders];
  const rank = new Map(order.map((id, index) => [id, index]));
  return folders
    .map((folder, index) => ({ folder, index }))
    .sort(
      (a, b) =>
        (rank.get(a.folder.id) ?? order.length + a.index) -
        (rank.get(b.folder.id) ?? order.length + b.index),
    )
    .map(({ folder }) => folder);
};

/**
 * Notebook sidebar folders. Drag a row (or its grip with Space, the arrow keys and
 * Space again) to reorder; `onReorder` receives the full new order of folder ids.
 */
export function FolderList({
  folders,
  selected,
  onSelect,
  onDelete,
  onReorder,
}: {
  folders: readonly FolderItem[];
  selected: string;
  onSelect: (id: string) => void;
  onDelete: (folder: FolderItem) => void;
  onReorder: (ids: string[]) => void;
}) {
  const sensors = useSensors(
    // A short travel threshold keeps plain clicks selecting the folder.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = folders.map((folder) => folder.id);
  const name = (id: UniqueIdentifier) =>
    folders.find((folder) => folder.id === id)?.name ?? "folder";
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);

  const finish = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragStart={({ active }) => setActiveId(active.id)}
      onDragEnd={finish}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "Press Space or Enter to pick up a folder. Use the arrow keys to move it, then Space or Enter to drop. Press Escape to cancel.",
        },
        announcements: {
          onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `${name(active.id)} is over ${name(over.id)}.` : `${name(active.id)} moved.`,
          onDragEnd: ({ active, over }) =>
            over
              ? `${name(active.id)} placed at position ${ids.indexOf(String(over.id)) + 1} of ${ids.length}.`
              : "Move cancelled.",
          onDragCancel: () => "Move cancelled. Folder order unchanged.",
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {folders.map((folder) => (
          <SortableFolder
            key={folder.id}
            folder={folder}
            selected={selected === folder.id}
            dragging={activeId === folder.id}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableFolder({
  folder,
  selected,
  dragging,
  onSelect,
  onDelete,
}: {
  folder: FolderItem;
  selected: boolean;
  dragging: boolean;
  onSelect: (id: string) => void;
  onDelete: (folder: FolderItem) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } =
    useSortable({ id: folder.id });
  // Pointer drags start anywhere on the row; keyboard drags only from the grip, so
  // Enter and Space on the folder name and delete button keep their usual meaning.
  const { onKeyDown, ...pointerListeners } = listeners ?? {};
  const startKeyboardDrag = onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined;
  const style: CSSProperties = {
    transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-folder-row={folder.id}
      data-dragging={dragging || undefined}
      className={cn(
        "group relative flex items-center rounded-md",
        dragging && "z-10 bg-background shadow-md ring-1 ring-border",
      )}
      {...pointerListeners}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        {...attributes}
        onKeyDown={startKeyboardDrag}
        aria-label={`Reorder folder: ${folder.name}`}
        title="Drag to reorder"
        className={cn(
          "absolute left-0 top-1/2 z-[1] flex h-7 w-3 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing",
          dragging && "opacity-100",
        )}
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={cn(
          "min-w-0 flex-1 break-words rounded-md py-1.5 pl-3 pr-2 text-left text-sm",
          selected ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60",
        )}
        onClick={() => onSelect(folder.id)}
      >
        {folder.name}
      </button>
      {folder.id !== "my-notes" && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`Delete folder: ${folder.name}`}
          onClick={() => onDelete(folder)}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}
