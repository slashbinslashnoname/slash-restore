import * as Progress from '@radix-ui/react-progress'

interface ProgressBarProps {
  value: number
  showPercentage?: boolean
  animated?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export default function ProgressBar({
  value,
  showPercentage = true,
  animated = true,
  size = 'md',
  className = ''
}: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, value))

  const heightMap = {
    sm: 'h-1.5',
    md: 'h-3',
    lg: 'h-5'
  }

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Progress.Root
        className={`relative flex-1 overflow-hidden rounded-full bg-surface-lighter ${heightMap[size]}`}
        value={clamped}
      >
        <Progress.Indicator
          className={`
            h-full rounded-full bg-primary-500 transition-[width] duration-300 ease-out
            ${animated && clamped > 0 && clamped < 100 ? 'animate-progress-stripe' : ''}
          `}
          style={{ width: `${clamped}%` }}
        />
      </Progress.Root>

      {showPercentage && (
        <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums text-gray-300">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  )
}
