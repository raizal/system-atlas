import boto3


def handler(event, context):
    client = boto3.client("s3")
    return client.list_buckets()
