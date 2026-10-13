import { PageHead, Note } from '../components/ui'
export default function Placeholder({ title = 'Coming soon' }: { title?: string }) {
  return <><PageHead title={title} /><Note>This screen is being built in the next milestone.</Note></>
}
