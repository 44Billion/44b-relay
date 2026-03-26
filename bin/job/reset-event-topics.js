import '#config/dotenv.js'
import mdb from '#services/db/mdb.js'

async function run () {
  console.log('Resetting event topics to direct hashtags only...')

  await mdb.index('events').updateDocumentsByFunction({
    function: `
      let tags = doc.indexableTags;
      let topics = [];
      if tags != () {
        for tag in tags {
          if tag.starts_with("t ") {
            let val = tag.sub_string(2);
            if val.len() >= 2 {
              topics.push(val);
            }
          }
        }
      }
      if topics.is_empty() {
        doc.topics = ();
      } else {
        doc.topics = topics;
      }
    `
  })

  console.log('Done. All event topics reset to direct hashtags from indexableTags.')
  process.exit(0)
}

run().catch(err => {
  console.error('Failed:', err)
  process.exit(1)
})
