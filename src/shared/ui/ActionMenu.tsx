import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export type ActionMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  isDanger?: boolean;
  showDividerBefore?: boolean;
  closeOnSelect?: boolean;
};

type ActionMenuProps = {
  label: string;
  items: ActionMenuItem[];
  icon?: LucideIcon;
  ariaLabel?: string;
  align?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  portal?: boolean;
  menuWidth?: number;
  header?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
};

/** 聊天、MCP 和侧栏模块用它展示操作菜单及新建会话的项目选择菜单。 */
export function ActionMenu({
  label,
  items,
  icon: TriggerIcon,
  ariaLabel,
  align = 'right',
  variant = 'outline',
  size = 'sm',
  className,
  triggerClassName,
  menuClassName,
  disabled,
  iconOnly = false,
  portal = false,
  menuWidth = 260,
  header,
  onOpenChange,
}: ActionMenuProps) {
  // 保留菜单开关，以便统一处理鼠标、键盘和焦点恢复。
  const [isOpen, setIsOpen] = React.useState(false);
  // 根据真实菜单尺寸限制浮层位置，避免窄侧栏或长路径造成窗口外裁切。
  const [portalPosition, setPortalPosition] = React.useState<{
    top: number; left: number; width: number; maxHeight: number;
  } | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Whether closing should move focus back to the trigger. Set for keyboard
  // (Escape) and item selection, but left false for outside pointer clicks so
  // focus is not stolen from wherever the user clicked.
  const restoreFocusRef = React.useRef(false);
  const focusMenuOnOpenRef = React.useRef(false);
  const wasOpenRef = React.useRef(false);
  const menuId = React.useId();

  React.useLayoutEffect(() => {
    if (!isOpen || !portal || !triggerRef.current || !menuRef.current) {
      return;
    }

    const rect = triggerRef.current.getBoundingClientRect();
    const width = Math.min(menuWidth, Math.max(0, window.innerWidth - 16));
    // offsetHeight 不受菜单的缩放入场动画影响。
    const height = menuRef.current.offsetHeight || menuRef.current.getBoundingClientRect().height;
    const below = Math.max(0, window.innerHeight - rect.bottom - 14);
    const above = Math.max(0, rect.top - 14);
    const openBelow = height <= below || below >= above;
    const maxHeight = Math.min(height || window.innerHeight, openBelow ? below : above);
    const preferredLeft = align === 'left' ? rect.left : rect.right - width;

    setPortalPosition({
      top: openBelow ? rect.bottom + 6 : Math.max(8, rect.top - maxHeight - 6),
      left: Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8)),
      width,
      maxHeight,
    });
  }, [isOpen, portal, align, menuWidth, items, header]);

  const setMenuOpen = React.useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setPortalPosition(null);
    }
    onOpenChange?.(open);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current
        && !rootRef.current.contains(target)
        && !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        restoreFocusRef.current = true;
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen, setMenuOpen]);

  React.useEffect(() => {
    if (!isOpen || !portal) {
      return;
    }

    const closeOnViewportChange = (event: Event) => {
      // 滚动菜单自己的项目列表时保持展开；只在锚点或窗口移动时关闭。
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
        return;
      }
      setMenuOpen(false);
    };
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [isOpen, portal, setMenuOpen]);

  // Move focus into the menu on open and back to the trigger on a keyboard or
  // selection close, so keyboard and screen-reader navigation match the menu role.
  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      if (focusMenuOnOpenRef.current) {
        const menu = menuRef.current;
        const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
        (firstItem ?? menu)?.focus();
      }
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (restoreFocusRef.current) {
        triggerRef.current?.focus();
      }
      restoreFocusRef.current = false;
    }
  }, [isOpen]);

  const runItem = (item: ActionMenuItem) => {
    if (item.disabled || item.loading) {
      return;
    }

    if (item.closeOnSelect !== false) {
      restoreFocusRef.current = true;
      setMenuOpen(false);
    }
    item.onSelect();
  };

  const toggleMenu = () => {
    if (isOpen) {
      setMenuOpen(false);
      return;
    }

    setMenuOpen(true);
  };

  const menu = isOpen && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      tabIndex={-1}
      data-escape-layer
      className={cn(
        portal ? 'fixed z-[70] min-w-0 overflow-x-hidden overflow-y-auto' : 'absolute top-full z-50 mt-2 min-w-[220px]',
        'rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        'animate-in fade-in-0 zoom-in-95',
        !portal && (align === 'right' ? 'right-0' : 'left-0'),
        menuClassName,
      )}
      style={portal ? portalPosition ?? {
        width: Math.min(menuWidth, Math.max(0, window.innerWidth - 16)),
        visibility: 'hidden',
      } : undefined}
    >
      {header}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <React.Fragment key={item.key}>
            {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled || item.loading}
              onClick={() => runItem(item)}
              className={cn(
                'flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                'focus:outline-none focus-visible:bg-accent',
                item.disabled || item.loading
                  ? 'cursor-not-allowed opacity-50'
                  : item.isDanger
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                    : 'hover:bg-accent',
              )}
            >
              {item.loading ? (
                <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              ) : (
                Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium leading-5" title={item.label}>{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground" title={item.description}>
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel || label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={(event) => {
          focusMenuOnOpenRef.current = event.detail === 0;
          toggleMenu();
        }}
      >
        {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
        {!iconOnly && (
          <>
            <span>{label}</span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
          </>
        )}
      </Button>

      {portal && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
    </div>
  );
}
