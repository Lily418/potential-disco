"use strict"

const Promise = require("bluebird")
const request = require("request-promise")
const cron = require("node-cron")
const r = require("rethinkdb")
const parser = Promise.promisify(require("node-feedparser"))
const ner = Promise.promisifyAll(require("ner"))

const nerServerOptions= {
    port: parseInt(process.env.NER_PORT),
    host:process.env.NER_HOST
}

function updateArticles() {
    let connection = null

    const selectNewArticlesPromise = r.connect( {host: process.env.RETHINK_DB_HOST , port: parseInt(process.env.RETHINK_DB_PORT)})
    .then((conn) => {
        connection = conn
    })
    .then(() => {
        return request("http://feeds.bbci.co.uk/news/world/rss.xml")
    })
    .then((rssString) => {
        return parser(rssString)
    })
    .then((rssFeed) => { 
      //Select articles which are not already contained in the table
        return r.expr(rssFeed.items).filter((item) => {
            return r.table("articles")("link").contains(item("link")).not()
        }).run(connection)
    })


    const getTaggedEntitiesPromise = selectNewArticlesPromise.then((newArticles) => {
        let items = newArticles.map((item) => {
            return ner.getAsync(nerServerOptions, item.description)
        })
  
        return Promise.all(items)
    })

    Promise.join(selectNewArticlesPromise, getTaggedEntitiesPromise, (newArticles, taggedEntities) => {

        let items = newArticles.map((item, index) => {
            let taggedEntitiesForItem = taggedEntities[index].entities
            let flattenedTaggedEntitiesForItem = [...taggedEntitiesForItem.LOCATION, ...taggedEntitiesForItem.ORGANIZATION, ...taggedEntitiesForItem.PERSON]
            return Object.assign({}, item, {"entities" : flattenedTaggedEntitiesForItem})
        })
      
    //The articles table has a primary key called link
    //Each item in the article array has a link property which will be unique
    //This way we ensure we only store each article once
        return r.table("articles").insert(items).run(connection)
    })
  .then((result) => {
      console.log(result)
      connection.close()
  })
  .catch((err) => {
      console.error(err)
  })
}

updateArticles()
cron.schedule("*/5 * * * *", updateArticles)
