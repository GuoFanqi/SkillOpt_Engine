import { Loader2 } from 'lucide-react'

interface LoadingProps {
  size?: 'sm' | 'md' | 'lg'
  text?: string
  inline?: boolean
}

export default function Loading({ size = 'md', text, inline = false }: LoadingProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  }

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  }

  if (inline) {
    return (
      <span className="flex items-center gap-2">
        <Loader2 className={`${sizeClasses[size]} animate-spin text-indigo-500`} />
        {text && <span className={`${textSizeClasses[size]} text-gray-500`}>{text}</span>}
      </span>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3">
      <Loader2 className={`${sizeClasses[size]} animate-spin text-indigo-500`} />
      {text && <span className={`${textSizeClasses[size]} text-gray-500`}>{text}</span>}
    </div>
  )
}

export function LoadingOverlay({ text = '加载中...' }: { text?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur-sm">
      <Loading size="lg" text={text} />
    </div>
  )
}

// ─── Skeleton components for page loading states ───

export function SkeletonBox({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse bg-gray-200 rounded-xl ${className}`} />
  )
}

/** Page header skeleton: title + action buttons */
export function PageHeaderSkeleton({ withActions = true }: { withActions?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div className="space-y-3">
        <SkeletonBox className="w-48 h-7" />
        <SkeletonBox className="w-32 h-4" />
      </div>
      {withActions && (
        <div className="flex gap-3">
          <SkeletonBox className="w-28 h-10 rounded-xl" />
          <SkeletonBox className="w-20 h-10 rounded-xl" />
        </div>
      )}
    </div>
  )
}

/** Dashboard card skeleton */
export function CardSkeleton() {
  return (
    <div className="bg-white rounded-xl p-5 border border-gray-100 space-y-4">
      <div className="flex items-center gap-2">
        <SkeletonBox className="w-2 h-2 rounded-full" />
        <SkeletonBox className="w-32 h-4" />
        <SkeletonBox className="w-14 h-5 rounded-full ml-auto" />
      </div>
      <SkeletonBox className="w-full h-16" />
      <div className="flex items-center justify-between">
        <SkeletonBox className="w-12 h-3" />
        <SkeletonBox className="w-16 h-3" />
      </div>
    </div>
  )
}

/** Dashboard grid of skeleton cards */
export function DashboardSkeleton() {
  return (
    <div>
      <PageHeaderSkeleton />
      {/* Stats row */}
      <div className="grid grid-cols-4 gap-5 mb-8">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100 space-y-3">
            <div className="flex items-center justify-between">
              <SkeletonBox className="w-16 h-4" />
              <SkeletonBox className="w-9 h-9 rounded-xl" />
            </div>
            <SkeletonBox className="w-20 h-8" />
            <SkeletonBox className="w-24 h-3" />
          </div>
        ))}
      </div>
      {/* Achievement banner */}
      <SkeletonBox className="w-full h-[88px] rounded-2xl mb-6" />
      {/* Cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {[...Array(6)].map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

/** Training list skeleton */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="space-y-3">
        {[...Array(rows)].map((_, i) => (
          <div key={i} className="bg-gray-50 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-4">
              <SkeletonBox className="w-5 h-5 rounded-full" />
              <SkeletonBox className="w-64 h-4" />
              <SkeletonBox className="w-16 h-5 rounded-full" />
              <div className="flex-1" />
              <SkeletonBox className="w-16 h-8 rounded-lg" />
              <SkeletonBox className="w-16 h-8 rounded-lg" />
              <SkeletonBox className="w-16 h-8 rounded-lg" />
            </div>
            <div className="flex gap-6">
              <SkeletonBox className="w-24 h-3" />
              <SkeletonBox className="w-16 h-3" />
              <SkeletonBox className="w-16 h-3" />
              <SkeletonBox className="w-24 h-3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Detail page skeleton */
export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <SkeletonBox className="w-10 h-10 rounded-xl" />
          <SkeletonBox className="w-40 h-6 rounded-lg" />
          <div>
            <SkeletonBox className="w-32 h-7 mb-2" />
            <SkeletonBox className="w-48 h-4" />
          </div>
        </div>
        <div className="flex gap-3">
          <SkeletonBox className="w-20 h-10 rounded-xl" />
          <SkeletonBox className="w-24 h-10 rounded-xl" />
          <SkeletonBox className="w-20 h-10 rounded-xl" />
          <SkeletonBox className="w-10 h-10 rounded-xl" />
        </div>
      </div>
      {/* Pipeline */}
      <SkeletonBox className="w-full h-[60px] rounded-2xl" />
      {/* Tabs */}
      <div className="flex gap-8 border-b border-gray-100 pb-0 mb-6">
        {[...Array(6)].map((_, i) => (
          <SkeletonBox key={i} className="w-12 h-8" />
        ))}
      </div>
      {/* Content grid */}
      <div className="grid grid-cols-3 gap-6">
        <div className="space-y-5">
          {[...Array(3)].map((_, i) => (
            <SkeletonBox key={i} className="w-full h-[200px] rounded-2xl" />
          ))}
        </div>
        <div className="col-span-2 space-y-5">
          <SkeletonBox className="w-full h-[280px] rounded-2xl" />
          <SkeletonBox className="w-full h-[200px] rounded-2xl" />
        </div>
      </div>
    </div>
  )
}