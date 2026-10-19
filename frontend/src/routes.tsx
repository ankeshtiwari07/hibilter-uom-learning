import { ComponentType, lazy } from 'react'
import type { Role } from './lib/auth'

type R = { path: string; roles: Role[]; crumbs: string[]; C: ComponentType<any>; demoOff?: boolean }  // demoOff: closed in demo mode
const S: Role[] = ['student'], LE: Role[] = ['lecturer'], A: Role[] = ['admin'], LA: Role[] = ['lecturer', 'admin'], ALL: Role[] = ['student', 'lecturer', 'admin']
const lz = (f: () => Promise<{ default: ComponentType<any> }>) => lazy(f)

export const ROUTES: R[] = [
  { path: '/s-classroom', roles: ALL, crumbs: ['Virtual faculty'], C: lz(() => import('./pages/student/FacultySelect')) },
  { path: '/s-classroom/:lessonId', roles: ALL, crumbs: ['Virtual classroom'], demoOff: true, C: lz(() => import('./classroom/Classroom')) },
  // student
  { path: '/s-dash', roles: S, crumbs: ['Dashboard'], C: lz(() => import('./pages/student/Dashboard')) },
  { path: '/s-catalogue', roles: S, crumbs: ['Course catalogue'], C: lz(() => import('./pages/student/Catalogue')) },
  { path: '/s-courses', roles: S, crumbs: ['My courses'], C: lz(() => import('./pages/student/MyCourses')) },
  { path: '/s-course', roles: S, crumbs: ['My courses'], C: lz(() => import('./pages/student/Course')) },
  { path: '/s-course/:courseId', roles: S, crumbs: ['My courses', 'Course'], C: lz(() => import('./pages/student/Course')) },
  { path: '/s-lesson', roles: S, crumbs: ['Lesson player'], C: lz(() => import('./pages/student/LessonPlayer')) },
  { path: '/s-ai', roles: S, crumbs: ['AI study assistant'], C: lz(() => import('./pages/student/Assistant')) },
  { path: '/s-assign', roles: S, crumbs: ['Assignments'], C: lz(() => import('./pages/student/Assignments')) },
  { path: '/s-quiz', roles: S, crumbs: ['Quizzes'], C: lz(() => import('./pages/student/Quiz')) },
  { path: '/s-progress', roles: S, crumbs: ['My progress'], C: lz(() => import('./pages/student/Progress')) },
  { path: '/s-cal', roles: S, crumbs: ['Timetable'], C: lz(() => import('./pages/student/Calendar')) },
  { path: '/s-news', roles: S, crumbs: ['Announcements'], C: lz(() => import('./pages/student/Announcements')) },
  { path: '/s-support', roles: S, crumbs: ['Support'], C: lz(() => import('./pages/student/Support')) },
  { path: '/s-profile', roles: S, crumbs: ['Profile & settings'], C: lz(() => import('./pages/student/Profile')) },
  // lecturer
  { path: '/l-dash', roles: LE, crumbs: ['Dashboard'], C: lz(() => import('./pages/lecturer/Dashboard')) },
  { path: '/l-courses', roles: LE, crumbs: ['Course management'], C: lz(() => import('./pages/lecturer/Courses')) },
  { path: '/l-editor', roles: LE, crumbs: ['Lesson editor'], C: lz(() => import('./pages/lecturer/LessonEditor')) },
  { path: '/l-builder', roles: LE, crumbs: ['Assessment builder'], C: lz(() => import('./pages/lecturer/AssessmentBuilder')) },
  { path: '/l-grading', roles: LE, crumbs: ['Submissions & grading'], C: lz(() => import('./pages/lecturer/Grading')) },
  { path: '/l-analytics', roles: LE, crumbs: ['Class analytics'], C: lz(() => import('./pages/lecturer/ClassAnalytics')) },
  { path: '/l-comms', roles: LE, crumbs: ['Communication'], C: lz(() => import('./pages/lecturer/Communication')) },
  { path: '/vf-gallery', roles: LA, crumbs: ['Virtual faculty', 'Faculty library'], demoOff: true, C: lz(() => import('./pages/student/FacultySelect')) },
  { path: '/vf-config', roles: LA, crumbs: ['Virtual faculty', 'Configure'], C: lz(() => import('./pages/lecturer/VFConfig')) },
  { path: '/vf-review', roles: LA, crumbs: ['Virtual faculty', 'Review queue'], C: lz(() => import('./pages/lecturer/VFReview')) },
  { path: '/vf-analytics', roles: LA, crumbs: ['Virtual faculty', 'Analytics'], C: lz(() => import('./pages/lecturer/VFAnalytics')) },
  // admin
  { path: '/a-dash', roles: A, crumbs: ['Institutional overview'], C: lz(() => import('./pages/admin/Dashboard')) },
  { path: '/a-structure', roles: A, crumbs: ['Academic structure'], C: lz(() => import('./pages/admin/Structure')) },
  { path: '/a-directory', roles: A, crumbs: ['Student directory'], C: lz(() => import('./pages/admin/Directory')) },
  { path: '/a-perf', roles: A, crumbs: ['Performance analytics'], C: lz(() => import('./pages/admin/Performance')) },
  { path: '/a-risk', roles: A, crumbs: ['Learners for follow-up'], C: lz(() => import('./pages/admin/Risk')) },
  { path: '/a-reports', roles: A, crumbs: ['Reporting centre'], C: lz(() => import('./pages/admin/Reports')) },
  { path: '/a-notices', roles: A, crumbs: ['Notices & calendar'], C: lz(() => import('./pages/admin/Notices')) },
  { path: '/a-users', roles: A, crumbs: ['Users & roles'], C: lz(() => import('./pages/admin/Users')) },
  { path: '/a-settings', roles: A, crumbs: ['Settings & audit'], C: lz(() => import('./pages/admin/Settings')) },
  { path: '/search', roles: ALL, crumbs: ['Search'], C: lz(() => import('./pages/common/Search')) },
]
