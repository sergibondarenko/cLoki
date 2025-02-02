/* Label Handler */
/*
   For retrieving the names of the labels one can query on.
   Responses looks like this:
{
  "values": [
    "instance",
    "job",
    ...
  ]
}
*/

function handler (req, res) {
  if (this.debug) console.log('GET /loki/api/v1/label')
  if (this.debug) console.log('QUERY: ', req.query)
  const allLabels = this.labels.get('_LABELS_')
  const resp = { status: 'success', data: allLabels }
  res.send(resp)
};

module.exports = handler
